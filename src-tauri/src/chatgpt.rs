//! Sign in with ChatGPT for open-source local apps.
//!
//! OAuth 2.0 authorization code flow with PKCE (S256) and a loopback redirect,
//! following OpenAI's open-source integration: the first sign-in uses
//! `client_id=dynamic_agent_client` and the callback returns the client id
//! issued to this installation, which is reused afterwards. The resulting
//! access token is sent as a Bearer token to the Responses API and draws on
//! the user's ChatGPT plan.
//!
//! Tokens are stored only in the OS credential store and never reach the
//! webview. The webview sees the connected account's name and email.

use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Notify};
use url::Url;

use crate::ai::client;
use crate::credentials::{blocking, delete_blob, read_blob, read_entry, write_blob, write_entry};
use crate::error::{CmdError, CmdResult};

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// Scope that lets requests draw on the user's ChatGPT plan.
const SHARING_SCOPE: &str = "chatgpt.tokens.use.direct";
const CALLBACK_PATH: &str = "/auth/callback";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const APP_NAME: &str = "LOGICA";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REFRESH_MARGIN_MS: u64 = 60_000;

/// Secure-store accounts.
const CONNECTION_ACCOUNT: &str = "openai:chatgpt";
const CLIENT_ACCOUNT: &str = "openai:chatgpt_client";

/// OAuth errors on refresh that mean the user has to sign in again.
const REAUTH_ERRORS: &[&str] = &[
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];

/// Sign-in and refresh coordination.
#[derive(Default)]
pub struct ChatGptAuth {
    /// Cancels the pending browser sign-in.
    sign_in: StdMutex<Option<Arc<Notify>>>,
    /// Serializes token refresh so a rotated refresh token is used once.
    refresh: Mutex<()>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Connection {
    version: u32,
    client_id: String,
    subject: String,
    email: Option<String>,
    name: Option<String>,
    scopes: Vec<String>,
    access_token: String,
    refresh_token: Option<String>,
    /// Milliseconds since the Unix epoch.
    expires_at: u64,
    earliest_refresh_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptStatus {
    connected: bool,
    email: Option<String>,
    name: Option<String>,
    /// False when the user declined plan usage during sign-in.
    plan_usage: bool,
    store_available: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutResult {
    /// Whether OpenAI confirmed the revocation; local tokens are removed either way.
    revoked: bool,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    revocation_endpoint: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn err(kind: &'static str, message: impl Into<String>) -> CmdError {
    CmdError::new(kind, message)
}

fn random_value() -> CmdResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| err("internal", format!("No secure random source: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn same_origin(endpoint: &str, issuer: &str) -> bool {
    Url::parse(endpoint).map(|u| u.origin().ascii_serialization() == issuer).unwrap_or(false)
}

/// OpenID discovery. Endpoints must belong to the issuer itself.
async fn discovery(issuer: &str) -> CmdResult<Discovery> {
    let failed = || err("chatgpt_unavailable", "ChatGPT sign-in configuration could not be verified. Try again later.");
    let response = client()?
        .get(format!("{issuer}/.well-known/openid-configuration"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| err("network", "Could not reach auth.openai.com. Check your connection."))?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let config: Discovery = response.json().await.map_err(|_| failed())?;
    let endpoints_ok = same_origin(&config.authorization_endpoint, issuer)
        && same_origin(&config.token_endpoint, issuer)
        && config.revocation_endpoint.as_deref().map(|e| same_origin(e, issuer)).unwrap_or(true);
    if config.issuer != issuer || !endpoints_ok {
        return Err(failed());
    }
    Ok(config)
}

// ------------------------------------------------------------------ storage

async fn load_connection() -> CmdResult<Option<Connection>> {
    blocking(|| read_blob(CONNECTION_ACCOUNT)).await?.map(|json| {
        json.and_then(|text| serde_json::from_str::<Connection>(&text).ok())
    })
}

async fn save_connection(connection: &Connection) -> CmdResult<()> {
    let json = serde_json::to_string(connection).map_err(|e| err("internal", e.to_string()))?;
    blocking(move || write_blob(CONNECTION_ACCOUNT, &json)).await?
}

async fn load_client_id() -> CmdResult<Option<String>> {
    blocking(|| read_entry(CLIENT_ACCOUNT)).await?
}

async fn save_client_id(client_id: String) -> CmdResult<()> {
    blocking(move || write_entry(CLIENT_ACCOUNT, &client_id)).await?
}

// ------------------------------------------------------------------ token endpoint

// No Debug on purpose: it holds tokens and must never end up in a log or panic message.
#[derive(Default)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
    earliest_refresh_at: Option<u64>,
    scopes: Vec<String>,
    id_token: Option<String>,
}

fn oauth_error(status: u16, body: &str) -> CmdError {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let code = json
        .get("error")
        .and_then(|e| e.as_str().map(str::to_string).or_else(|| e.get("code").and_then(|c| c.as_str()).map(str::to_string)))
        .unwrap_or_else(|| format!("http_{status}"));
    let safe: String = code.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(80).collect();
    if REAUTH_ERRORS.contains(&safe.as_str()) {
        return err("chatgpt_expired", "Your ChatGPT connection has expired. Sign in with ChatGPT again.");
    }
    let mut e = err("chatgpt_auth", format!("ChatGPT sign-in failed ({safe})."));
    e.status = Some(status);
    e
}

async fn token_request(endpoint: &str, form: &[(&str, &str)]) -> CmdResult<serde_json::Value> {
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
    let response = client()?
        .post(endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| err("network", "Could not reach auth.openai.com. Check your connection."))?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(oauth_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|_| err("chatgpt_auth", "ChatGPT returned an invalid token response."))
}

fn parse_earliest(value: Option<&serde_json::Value>) -> Option<u64> {
    match value? {
        serde_json::Value::Number(n) => n.as_f64().map(|secs| (secs * 1000.0) as u64),
        serde_json::Value::String(s) => parse_rfc3339(s),
        _ => None,
    }
}

/// Parse an RFC 3339 UTC timestamp ("2026-10-12T10:00:00Z") into epoch ms.
fn parse_rfc3339(s: &str) -> Option<u64> {
    let s = s.trim();
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let time = time.split(['+']).next()?;
    let mut t = time.split(':');
    let (hh, mm) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let ss = t.next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    // Days from civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hh * 3600 + mm * 60;
    u64::try_from(secs).ok().map(|s| s * 1000 + (ss * 1000.0) as u64)
}

fn parse_tokens(data: &serde_json::Value, previous_scopes: Option<&[String]>, require_refresh: bool) -> CmdResult<TokenResponse> {
    let invalid = |m: &str| err("chatgpt_auth", format!("ChatGPT returned incomplete credentials ({m}). Sign in again."));
    let scopes: Vec<String> = match data.get("scope").and_then(|s| s.as_str()) {
        Some(scope) => scope.split_whitespace().map(str::to_string).collect(),
        // OAuth may omit scope on refresh when it is unchanged.
        None => previous_scopes.map(<[String]>::to_vec).ok_or_else(|| invalid("scope"))?,
    };
    let access_token = data.get("access_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).ok_or_else(|| invalid("access token"))?;
    let token_type = data.get("token_type").and_then(|v| v.as_str()).unwrap_or_default();
    if !token_type.eq_ignore_ascii_case("bearer") {
        return Err(invalid("token type"));
    }
    let expires_in = data.get("expires_in").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).ok_or_else(|| invalid("expiry"))?;
    let refresh_token = data.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    if (require_refresh || scopes.iter().any(|s| s == "offline_access")) && refresh_token.is_none() {
        return Err(invalid("refresh token"));
    }
    Ok(TokenResponse {
        access_token: access_token.to_string(),
        refresh_token,
        expires_at: now_ms() + (expires_in * 1000.0) as u64,
        earliest_refresh_at: parse_earliest(data.get("earliest_refresh_at")),
        scopes,
        id_token: data.get("id_token").and_then(|v| v.as_str()).map(str::to_string),
    })
}

struct Identity {
    subject: String,
    email: Option<String>,
    name: Option<String>,
}

/// Validate the ID token claims (issuer, audience, expiry, nonce).
///
/// The token comes directly from the token endpoint over TLS, so per OpenID
/// Connect Core 3.1.3.7 the TLS server validation authenticates the issuer and
/// the signature check can be skipped; the claims are still checked.
fn verify_id_token(id_token: &str, issuer: &str, client_id: &str, nonce: Option<&str>) -> CmdResult<Identity> {
    let invalid = || err("chatgpt_auth", "The ChatGPT identity could not be verified. Sign in again.");
    let payload = id_token.split('.').nth(1).ok_or_else(invalid)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).map_err(|_| invalid())?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let str_claim = |k: &str| claims.get(k).and_then(|v| v.as_str());
    if str_claim("iss") != Some(issuer) {
        return Err(invalid());
    }
    let audience_ok = match claims.get("aud") {
        Some(serde_json::Value::String(a)) => a == client_id,
        Some(serde_json::Value::Array(list)) => {
            list.iter().any(|a| a.as_str() == Some(client_id)) && (list.len() == 1 || str_claim("azp") == Some(client_id))
        }
        _ => false,
    };
    if !audience_ok || str_claim("azp").is_some_and(|azp| azp != client_id) {
        return Err(invalid());
    }
    let exp = claims.get("exp").and_then(|v| v.as_f64()).ok_or_else(invalid)?;
    if exp * 1000.0 + 5000.0 < now_ms() as f64 {
        return Err(invalid());
    }
    if let Some(expected) = nonce {
        if str_claim("nonce") != Some(expected) {
            return Err(invalid());
        }
    }
    let subject = str_claim("sub").filter(|s| !s.is_empty()).ok_or_else(invalid)?.to_string();
    Ok(Identity {
        subject,
        email: str_claim("email").map(str::to_string),
        name: str_claim("name").map(str::to_string),
    })
}

// ------------------------------------------------------------------ loopback callback

const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Return to LOGICA</title><style>body{font:16px system-ui;max-width:32rem;margin:18vh auto;padding:24px;color:#1e293b}h1{font-size:24px}</style><h1>Return to LOGICA</h1><p>LOGICA is finishing your ChatGPT connection. You can close this tab.</p></html>";

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn valid_client_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id != DYNAMIC_CLIENT && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

struct Callback {
    code: String,
    client_id: String,
}

/// Outcome of one loopback request.
enum Handled {
    Done(CmdResult<Callback>),
    Ignored,
}

async fn handle_request(stream: &mut TcpStream, port: u16, state: &str, saved_client: Option<&str>) -> Handled {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        while !buffer.windows(4).any(|w| w == b"\r\n\r\n") && buffer.len() < 16 * 1024 {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await;
    if read.is_err() {
        return Handled::Ignored;
    }
    let request = String::from_utf8_lossy(&buffer);
    let mut lines = request.split("\r\n");
    let mut parts = lines.next().unwrap_or_default().split(' ');
    let (method, target) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let expected_host = format!("127.0.0.1:{port}");
    let host_ok = lines.any(|l| {
        l.split_once(':')
            .map(|(k, v)| k.trim().eq_ignore_ascii_case("host") && v.trim() == expected_host)
            .unwrap_or(false)
    });
    let url = Url::parse(&format!("http://{expected_host}{target}"));
    let Ok(url) = url else {
        respond(stream, "400 Bad Request", "Invalid request").await;
        return Handled::Ignored;
    };
    if method != "GET" || !host_ok || url.path() != CALLBACK_PATH {
        respond(stream, "404 Not Found", "Not found").await;
        return Handled::Ignored;
    }
    let params: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let all = |k: &str| params.iter().filter(|(n, _)| n == k).map(|(_, v)| v.as_str()).collect::<Vec<_>>();
    let states = all("state");
    if states.len() != 1 || !constant_time_eq(states[0].as_bytes(), state.as_bytes()) {
        // Unrelated requests must not consume the pending sign-in.
        respond(stream, "400 Bad Request", "Invalid sign-in state. Return to the browser tab that LOGICA opened.").await;
        return Handled::Ignored;
    }
    respond(stream, "200 OK", DONE_PAGE).await;
    if let Some(error) = all("error").first() {
        let code: String = error.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(80).collect();
        return Handled::Done(Err(if code == "access_denied" {
            err("cancelled", "ChatGPT sign-in was cancelled.")
        } else {
            err("chatgpt_auth", format!("ChatGPT sign-in failed ({code})."))
        }));
    }
    let codes = all("code");
    let returned = all("client_id");
    let client_id = returned.first().copied().or(saved_client);
    let result = match (codes.as_slice(), client_id) {
        ([code], Some(id)) if returned.len() <= 1 && valid_client_id(id) && saved_client.is_none_or(|s| returned.first().is_none_or(|r| *r == s)) => {
            Ok(Callback { code: code.to_string(), client_id: id.to_string() })
        }
        _ => Err(err("chatgpt_auth", "ChatGPT did not complete app registration. Please sign in again.")),
    };
    Handled::Done(result)
}

async fn wait_for_callback(listener: TcpListener, port: u16, state: String, saved_client: Option<String>) -> CmdResult<Callback> {
    loop {
        let (mut stream, peer) = listener.accept().await.map_err(|e| err("internal", format!("Sign-in listener failed: {e}")))?;
        if !peer.ip().is_loopback() {
            continue;
        }
        if let Handled::Done(result) = handle_request(&mut stream, port, &state, saved_client.as_deref()).await {
            return result;
        }
    }
}

// ------------------------------------------------------------------ flows

/// Browser sign-in. `open_browser` shows the authorization page; the issued
/// client id is handed to `on_registration` before the code exchange.
async fn sign_in_flow<R, RF>(
    issuer: &str,
    previous: Option<Connection>,
    saved_client: Option<String>,
    open_browser: impl FnOnce(&str) -> CmdResult<()>,
    on_registration: R,
) -> CmdResult<Connection>
where
    R: FnOnce(String) -> RF,
    RF: Future<Output = CmdResult<()>>,
{
    let config = discovery(issuer).await?;
    let state = random_value()?;
    let nonce = random_value()?;
    let verifier = random_value()?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| err("internal", "Could not open a local port for the sign-in callback."))?;
    let port = listener.local_addr().map_err(|e| err("internal", e.to_string()))?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

    let mut authorize = Url::parse(&config.authorization_endpoint).map_err(|_| err("chatgpt_unavailable", "Invalid authorization endpoint"))?;
    {
        let mut q = authorize.query_pairs_mut();
        q.append_pair("client_id", saved_client.as_deref().unwrap_or(DYNAMIC_CLIENT))
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &pkce_challenge(&verifier));
        if saved_client.is_none() {
            q.append_pair("agent_name_hint", APP_NAME);
        }
        if let Some(email) = previous.as_ref().and_then(|c| c.email.as_deref()) {
            q.append_pair("login_hint", email);
        }
    }
    open_browser(authorize.as_str())?;

    let callback = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_callback(listener, port, state, saved_client.clone()))
        .await
        .map_err(|_| err("timeout", "ChatGPT sign-in timed out. Please try again."))??;
    // Keep the issued registration even if the code exchange fails, so the
    // next attempt does not register the app again.
    on_registration(callback.client_id.clone()).await?;

    let data = token_request(
        &config.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &callback.client_id),
            ("code", &callback.code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect_uri),
            ("resource", RESOURCE),
        ],
    )
    .await?;
    let tokens = parse_tokens(&data, None, false)?;
    let id_token = tokens
        .id_token
        .as_deref()
        .ok_or_else(|| err("chatgpt_auth", "ChatGPT did not return a verifiable identity. Please sign in again."))?;
    let identity = verify_id_token(id_token, issuer, &callback.client_id, Some(&nonce))?;
    Ok(Connection {
        version: 1,
        client_id: callback.client_id,
        subject: identity.subject,
        email: identity.email,
        name: identity.name,
        scopes: tokens.scopes,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        earliest_refresh_at: tokens.earliest_refresh_at,
    })
}

/// Refresh the access token. The old refresh token is consumed by the server,
/// so the new token set is handed to `persist` before anything else can fail.
async fn refresh_flow<P, PF>(issuer: &str, previous: Connection, persist: P) -> CmdResult<Connection>
where
    P: Fn(Connection) -> PF,
    PF: Future<Output = CmdResult<()>>,
{
    let refresh_token = previous
        .refresh_token
        .clone()
        .ok_or_else(|| err("chatgpt_expired", "Your ChatGPT connection has expired. Sign in with ChatGPT again."))?;
    let config = discovery(issuer).await?;
    let data = token_request(
        &config.token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &previous.client_id),
            ("refresh_token", &refresh_token),
            ("resource", RESOURCE),
        ],
    )
    .await?;
    let tokens = parse_tokens(&data, Some(&previous.scopes), true)?;
    let mut next = Connection {
        scopes: tokens.scopes,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        earliest_refresh_at: tokens.earliest_refresh_at,
        ..previous.clone()
    };
    persist(next.clone()).await?;
    if let Some(id_token) = tokens.id_token.as_deref() {
        let identity = verify_id_token(id_token, issuer, &previous.client_id, None)?;
        if identity.subject != previous.subject {
            return Err(err("chatgpt_auth", "The refreshed ChatGPT account does not match. Sign in again."));
        }
        next.email = identity.email.or(next.email);
        next.name = identity.name.or(next.name);
        persist(next.clone()).await?;
    }
    Ok(next)
}

/// A valid access token for API requests, refreshing it when it is close to
/// expiry. Refresh runs in its own task so cancelling the AI request cannot
/// interrupt a refresh token rotation halfway.
pub async fn access_token(auth: &ChatGptAuth) -> CmdResult<String> {
    let _guard = auth.refresh.lock().await;
    let connection = load_connection()
        .await?
        .ok_or_else(|| err("no_credential", "Sign in with ChatGPT in Settings to use your ChatGPT plan."))?;
    if !connection.scopes.iter().any(|s| s == SHARING_SCOPE) {
        return Err(err(
            "no_credential",
            "You are signed in, but ChatGPT plan usage was not granted to LOGICA. Sign in again and allow plan usage.",
        ));
    }
    let now = now_ms();
    if connection.expires_at > now + REFRESH_MARGIN_MS {
        return Ok(connection.access_token);
    }
    let refresh_allowed = connection.earliest_refresh_at.is_none_or(|t| t <= now);
    if !refresh_allowed {
        if connection.expires_at > now {
            return Ok(connection.access_token);
        }
        return Err(err("chatgpt_unavailable", "Your ChatGPT connection cannot refresh yet. Try again shortly."));
    }
    let task = tauri::async_runtime::spawn(async move {
        refresh_flow(ISSUER, connection, |c| async move { save_connection(&c).await }).await
    });
    match task.await {
        Ok(Ok(next)) => Ok(next.access_token),
        Ok(Err(e)) => {
            if e.kind == "chatgpt_expired" {
                // Keep the account details for login_hint, drop unusable tokens.
                if let Ok(Some(mut c)) = load_connection().await {
                    c.access_token.clear();
                    c.refresh_token = None;
                    c.expires_at = 0;
                    let _ = save_connection(&c).await;
                }
            }
            Err(e)
        }
        Err(e) => Err(err("internal", e.to_string())),
    }
}

fn status_of(connection: Option<Connection>) -> ChatGptStatus {
    match connection {
        Some(c) => ChatGptStatus {
            connected: c.refresh_token.is_some() || c.expires_at > now_ms(),
            plan_usage: c.scopes.iter().any(|s| s == SHARING_SCOPE),
            email: c.email,
            name: c.name,
            store_available: true,
            error: None,
        },
        None => ChatGptStatus { connected: false, email: None, name: None, plan_usage: false, store_available: true, error: None },
    }
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn chatgpt_status() -> CmdResult<ChatGptStatus> {
    match load_connection().await {
        Ok(connection) => Ok(status_of(connection)),
        Err(e) => Ok(ChatGptStatus {
            connected: false,
            email: None,
            name: None,
            plan_usage: false,
            store_available: e.kind != "store_unavailable",
            error: Some(e.message),
        }),
    }
}

/// Open the browser for Sign in with ChatGPT and wait for the result.
#[tauri::command]
pub async fn chatgpt_sign_in(app: AppHandle, auth: State<'_, ChatGptAuth>) -> CmdResult<ChatGptStatus> {
    let cancel = Arc::new(Notify::new());
    {
        let mut slot = auth.sign_in.lock().map_err(|_| err("internal", "sign-in state poisoned"))?;
        if let Some(previous) = slot.replace(cancel.clone()) {
            previous.notify_one();
        }
    }
    let previous = load_connection().await.ok().flatten();
    let saved_client = match &previous {
        Some(c) => Some(c.client_id.clone()),
        None => load_client_id().await?,
    };
    let open_browser = |url: &str| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| err("browser_unavailable", "The browser could not be opened. Check your default browser and try again."))
    };
    let result = tokio::select! {
        r = sign_in_flow(ISSUER, previous, saved_client, open_browser, save_client_id) => r,
        _ = cancel.notified() => Err(err("cancelled", "ChatGPT sign-in was cancelled.")),
    };
    if let Ok(mut slot) = auth.sign_in.lock() {
        if slot.as_ref().is_some_and(|s| Arc::ptr_eq(s, &cancel)) {
            *slot = None;
        }
    }
    let connection = result?;
    let _guard = auth.refresh.lock().await;
    save_connection(&connection).await?;
    Ok(status_of(Some(connection)))
}

#[tauri::command]
pub async fn chatgpt_cancel_sign_in(auth: State<'_, ChatGptAuth>) -> CmdResult<bool> {
    let slot = auth.sign_in.lock().map_err(|_| err("internal", "sign-in state poisoned"))?;
    Ok(slot.as_ref().map(|n| n.notify_one()).is_some())
}

/// Revoke the session at OpenAI and delete the tokens from the OS store.
#[tauri::command]
pub async fn chatgpt_sign_out(auth: State<'_, ChatGptAuth>) -> CmdResult<SignOutResult> {
    let _guard = auth.refresh.lock().await;
    let connection = load_connection().await.ok().flatten();
    let mut revoked = false;
    if let Some(c) = &connection {
        if let (Some(token), Ok(config)) = (c.refresh_token.as_deref(), discovery(ISSUER).await) {
            if let Some(endpoint) = config.revocation_endpoint {
                let body = url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([("token", token), ("token_type_hint", "refresh_token"), ("client_id", c.client_id.as_str())])
                    .finish();
                if let Ok(client) = client() {
                    revoked = client
                        .post(endpoint)
                        .header("content-type", "application/x-www-form-urlencoded")
                        .body(body)
                        .timeout(Duration::from_secs(10))
                        .send()
                        .await
                        .map(|r| r.status().is_success())
                        .unwrap_or(false);
                }
            }
        }
    }
    // Local tokens are removed even if revocation could not be confirmed. The
    // issued client id is public registration data and is kept for reuse.
    blocking(|| delete_blob(CONNECTION_ACCOUNT)).await??;
    Ok(SignOutResult { revoked: revoked || connection.is_none() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: serde_json::Value) -> String {
        format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    #[test]
    fn pkce_matches_rfc7636_example() {
        // RFC 7636 Appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn id_token_claims_are_checked() {
        let exp = (now_ms() / 1000 + 600) as f64;
        let good = jwt(serde_json::json!({ "iss": ISSUER, "aud": "oaiapp_x", "exp": exp, "sub": "user-1", "nonce": "n", "email": "a@b.c" }));
        let id = verify_id_token(&good, ISSUER, "oaiapp_x", Some("n")).unwrap();
        assert_eq!(id.subject, "user-1");
        assert_eq!(id.email.as_deref(), Some("a@b.c"));
        assert!(verify_id_token(&good, ISSUER, "other", Some("n")).is_err());
        assert!(verify_id_token(&good, ISSUER, "oaiapp_x", Some("wrong")).is_err());
        let expired = jwt(serde_json::json!({ "iss": ISSUER, "aud": "oaiapp_x", "exp": 1.0, "sub": "u" }));
        assert!(verify_id_token(&expired, ISSUER, "oaiapp_x", None).is_err());
        let foreign = jwt(serde_json::json!({ "iss": "https://evil.example", "aud": "oaiapp_x", "exp": exp, "sub": "u" }));
        assert!(verify_id_token(&foreign, ISSUER, "oaiapp_x", None).is_err());
    }

    #[test]
    fn token_responses_are_validated() {
        let ok = serde_json::json!({ "access_token": "at", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "rt", "scope": SCOPES, "earliest_refresh_at": 1_700_000_000 });
        let t = parse_tokens(&ok, None, false).unwrap();
        assert_eq!(t.refresh_token.as_deref(), Some("rt"));
        assert_eq!(t.earliest_refresh_at, Some(1_700_000_000_000));
        let missing_refresh = serde_json::json!({ "access_token": "at", "token_type": "Bearer", "expires_in": 3600, "scope": "openid offline_access" });
        assert!(parse_tokens(&missing_refresh, None, false).is_err());
        let no_scope_on_refresh = serde_json::json!({ "access_token": "at", "token_type": "bearer", "expires_in": 10, "refresh_token": "rt2" });
        let prev = vec![SHARING_SCOPE.to_string()];
        assert_eq!(parse_tokens(&no_scope_on_refresh, Some(&prev), true).unwrap().scopes, prev);
    }

    #[test]
    fn parses_rfc3339_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-02T00:00:00Z"), Some(86_400_000));
        assert_eq!(parse_rfc3339("2026-10-12T10:00:00Z"), Some(1_791_799_200_000));
    }

    #[test]
    fn reauth_errors_are_classified() {
        assert_eq!(oauth_error(400, r#"{"error":"invalid_grant"}"#).kind, "chatgpt_expired");
        assert_eq!(oauth_error(400, r#"{"error":"invalid_client"}"#).kind, "chatgpt_auth");
    }

    async fn send(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn loopback_callback_checks_state_and_returns_issued_client() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(wait_for_callback(listener, port, "s3cret".into(), None));
        assert!(send(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(send(port, "/auth/callback?state=wrong&code=c").await.starts_with("HTTP/1.1 400"));
        assert!(send(port, "/auth/callback?state=s3cret&code=abc&client_id=oaiapp_123").await.starts_with("HTTP/1.1 200"));
        let callback = waiter.await.unwrap().unwrap();
        assert_eq!(callback.code, "abc");
        assert_eq!(callback.client_id, "oaiapp_123");
    }

    // ---- end-to-end flow against a local mock OAuth server

    #[derive(Default)]
    struct MockState {
        challenge: Option<String>,
        nonce: Option<String>,
        /// Refresh tokens rotate: each one can be used once.
        used_refresh: bool,
    }

    async fn mock_reply(stream: &mut TcpStream, status: &str, json: serde_json::Value) {
        let body = json.to_string();
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    async fn mock_handle(mut stream: TcpStream, origin: String, state: Arc<StdMutex<MockState>>) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let len = text[..head_end]
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                if buf.len() >= head_end + 4 + len {
                    break;
                }
            }
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let request_line = head.lines().next().unwrap_or_default().to_string();
        let form: std::collections::HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
        let exp = (now_ms() / 1000 + 3600) as f64;
        if request_line.starts_with("GET /.well-known/openid-configuration") {
            let config = serde_json::json!({
                "issuer": origin,
                "authorization_endpoint": format!("{origin}/oauth/authorize"),
                "token_endpoint": format!("{origin}/oauth/token"),
                "revocation_endpoint": format!("{origin}/oauth/revoke"),
            });
            return mock_reply(&mut stream, "200 OK", config).await;
        }
        if !request_line.starts_with("POST /oauth/token") {
            return mock_reply(&mut stream, "404 Not Found", serde_json::json!({})).await;
        }
        match form.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                let (challenge, nonce) = {
                    let st = state.lock().unwrap();
                    (st.challenge.clone().unwrap_or_default(), st.nonce.clone().unwrap_or_default())
                };
                let pkce_ok = form.get("code_verifier").map(|v| pkce_challenge(v)) == Some(challenge);
                if form.get("code").map(String::as_str) != Some("code-1") || form.get("client_id").map(String::as_str) != Some("oaiapp_test") || !pkce_ok || form.get("resource").map(String::as_str) != Some(RESOURCE) {
                    return mock_reply(&mut stream, "400 Bad Request", serde_json::json!({ "error": "invalid_grant" })).await;
                }
                let id_token = jwt(serde_json::json!({ "iss": origin, "aud": "oaiapp_test", "exp": exp, "sub": "user-42", "nonce": nonce, "email": "r@example.com", "name": "Researcher" }));
                mock_reply(&mut stream, "200 OK", serde_json::json!({
                    "access_token": "at-1", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "rt-1", "scope": SCOPES, "id_token": id_token
                }))
                .await
            }
            Some("refresh_token")
                if form.get("refresh_token").map(String::as_str) == Some("rt-1")
                    && !std::mem::replace(&mut state.lock().unwrap().used_refresh, true) =>
            {
                let id_token = jwt(serde_json::json!({ "iss": origin, "aud": "oaiapp_test", "exp": exp, "sub": "user-42" }));
                mock_reply(&mut stream, "200 OK", serde_json::json!({
                    "access_token": "at-2", "token_type": "bearer", "expires_in": 3600, "refresh_token": "rt-2", "id_token": id_token
                }))
                .await
            }
            _ => mock_reply(&mut stream, "400 Bad Request", serde_json::json!({ "error": "invalid_grant" })).await,
        }
    }

    #[tokio::test]
    async fn sign_in_and_refresh_against_mock_oauth_server() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(StdMutex::new(MockState::default()));
        {
            let (origin, state) = (origin.clone(), state.clone());
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(mock_handle(stream, origin.clone(), state.clone()));
                }
            });
        }

        // The "browser": check the authorization request, then follow the redirect.
        let open_browser = {
            let state = state.clone();
            move |url: &str| -> CmdResult<()> {
                let q: std::collections::HashMap<String, String> = Url::parse(url).unwrap().query_pairs().into_owned().collect();
                assert!(url.contains("/oauth/authorize?"));
                assert_eq!(q["client_id"], DYNAMIC_CLIENT);
                assert_eq!(q["agent_name_hint"], APP_NAME);
                assert_eq!(q["code_challenge_method"], "S256");
                assert_eq!(q["scope"], SCOPES);
                assert_eq!(q["resource"], RESOURCE);
                assert!(q["redirect_uri"].starts_with("http://127.0.0.1:") && q["redirect_uri"].ends_with(CALLBACK_PATH));
                {
                    let mut st = state.lock().unwrap();
                    st.challenge = Some(q["code_challenge"].clone());
                    st.nonce = Some(q["nonce"].clone());
                }
                let redirect = format!("{}?code=code-1&state={}&client_id=oaiapp_test", q["redirect_uri"], q["state"]);
                tokio::spawn(async move {
                    let _ = reqwest::get(redirect).await;
                });
                Ok(())
            }
        };
        let registered = Arc::new(StdMutex::new(None::<String>));
        let reg = registered.clone();
        let connection = sign_in_flow(&origin, None, None, open_browser, move |id| {
            *reg.lock().unwrap() = Some(id);
            async { Ok(()) }
        })
        .await
        .expect("sign-in");
        assert_eq!(registered.lock().unwrap().as_deref(), Some("oaiapp_test"));
        assert_eq!(connection.client_id, "oaiapp_test");
        assert_eq!(connection.subject, "user-42");
        assert_eq!(connection.email.as_deref(), Some("r@example.com"));
        assert_eq!(connection.access_token, "at-1");
        assert!(connection.scopes.iter().any(|s| s == SHARING_SCOPE));

        let persisted = Arc::new(StdMutex::new(Vec::new()));
        let log = persisted.clone();
        let next = refresh_flow(&origin, connection.clone(), move |c| {
            log.lock().unwrap().push(c.access_token.clone());
            async { Ok(()) }
        })
        .await
        .expect("refresh");
        assert_eq!(next.access_token, "at-2");
        assert_eq!(next.refresh_token.as_deref(), Some("rt-2"));
        assert_eq!(next.scopes, connection.scopes, "scope omitted on refresh keeps the granted scopes");
        assert_eq!(next.email.as_deref(), Some("r@example.com"));
        assert_eq!(persisted.lock().unwrap().first().map(String::as_str), Some("at-2"), "persisted before identity check");

        // A consumed refresh token means the user must sign in again.
        let reused = refresh_flow(&origin, connection, |_| async { Ok(()) }).await.err().expect("reuse must fail");
        assert_eq!(reused.kind, "chatgpt_expired");
    }

    #[tokio::test]
    async fn loopback_callback_rejects_unregistered_client() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(wait_for_callback(listener, port, "s".into(), None));
        send(port, "/auth/callback?state=s&code=abc&client_id=dynamic_agent_client").await;
        assert!(waiter.await.unwrap().is_err());
    }
}
