//! Credential-attaching transport for AI providers.
//!
//! Provider adapters (TypeScript, `src/ai/providers/*`) build provider-specific
//! request bodies and parse provider-specific streams. This module only:
//!
//! 1. checks the target against a fixed allowlist of provider endpoints,
//! 2. attaches the credential from the OS credential store,
//! 3. streams the raw response body back to the webview, and
//! 4. supports cancellation.
//!
//! The secret never leaves the Rust process and never appears in errors.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Notify;

use crate::chatgpt::{self, ChatGptAuth};
use crate::credentials::read_secret;
use crate::error::{CmdError, CmdResult};

const OPENAI_BASE: &str = "https://api.openai.com";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_ERROR_BODY: usize = 16 * 1024;

/// In-flight streaming requests, keyed by the frontend request id.
#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<String, Arc<Notify>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    request_id: String,
    provider: String,
    path: String,
    body: serde_json::Value,
    /// OpenAI only: `api_key` (default) or `chatgpt` (Sign in with ChatGPT).
    #[serde(default)]
    auth: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Open { status: u16 },
    Chunk { data: String },
    Done,
}

pub(crate) fn client() -> CmdResult<&'static reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // Per-read idle timeout; reasoning models can pause before the first token.
        .read_timeout(Duration::from_secs(300))
        .user_agent(concat!("LOGICA/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CmdError::new("internal", format!("HTTP client error: {e}")))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// Only these provider endpoints can be reached through this transport.
fn endpoint(provider: &str, method: &str, path: &str) -> CmdResult<String> {
    let allowed = match (provider, method, path) {
        ("openai", "POST", "/v1/responses") => true,
        ("openai", "GET", "/v1/models") => true,
        ("anthropic", "POST", "/v1/messages") => true,
        ("anthropic", "GET", "/v1/models") => true,
        _ => false,
    };
    if !allowed {
        return Err(CmdError::new(
            "invalid_request",
            format!("Endpoint not allowed: {provider} {method} {path}"),
        ));
    }
    let base = if provider == "openai" { OPENAI_BASE } else { ANTHROPIC_BASE };
    let query = if provider == "anthropic" && path == "/v1/models" { "?limit=1000" } else { "" };
    Ok(format!("{base}{path}{query}"))
}

fn auth_headers(provider: &str, secret: &str) -> CmdResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    let invalid = |_| CmdError::new("invalid_key", "The stored API key contains invalid characters");
    match provider {
        "openai" => {
            let mut value = HeaderValue::from_str(&format!("Bearer {secret}")).map_err(invalid)?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        "anthropic" => {
            let mut value = HeaderValue::from_str(secret).map_err(invalid)?;
            value.set_sensitive(true);
            headers.insert("x-api-key", value);
            headers.insert("anthropic-version", HeaderValue::from_static(ANTHROPIC_VERSION));
        }
        _ => return Err(CmdError::new("invalid_provider", format!("Unknown provider: {provider}"))),
    }
    Ok(headers)
}

/// Remove anything that could be a credential from text shown to the user.
fn redact(text: &str, secret: &str) -> String {
    let mut out = if secret.len() >= 8 { text.replace(secret, "***") } else { text.to_string() };
    // Mask key-like tokens (`sk-...`) that providers sometimes echo back.
    let mut result = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(idx) = rest.find("sk-") {
        result.push_str(&rest[..idx]);
        let token_len = rest[idx..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '*'))
            .unwrap_or(rest.len() - idx);
        if token_len > 12 {
            result.push_str("sk-***");
        } else {
            result.push_str(&rest[idx..idx + token_len]);
        }
        rest = &rest[idx + token_len..];
    }
    result.push_str(rest);
    out = result;
    out
}

fn network_error(err: reqwest::Error, secret: &str) -> CmdError {
    let kind = if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "network"
    } else if err.is_body() || err.is_decode() {
        "stream_interrupted"
    } else {
        "network"
    };
    CmdError::new(kind, redact(&err.to_string(), secret))
}

async fn load_secret(provider: &str) -> CmdResult<String> {
    let provider_owned = provider.to_string();
    let secret = tauri::async_runtime::spawn_blocking(move || read_secret(&provider_owned))
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))??;
    secret.ok_or_else(|| {
        CmdError::new(
            "no_credential",
            format!("{} is not connected. Add an API key in Settings.", provider_name(provider)),
        )
    })
}

fn provider_name(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Claude (Anthropic)",
        _ => "Provider",
    }
}

async fn http_error(response: reqwest::Response, secret: &str) -> CmdError {
    let status = response.status().as_u16();
    let mut body = response.text().await.unwrap_or_default();
    if body.len() > MAX_ERROR_BODY {
        let mut cut = MAX_ERROR_BODY;
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
    }
    let mut err = CmdError::new("http_error", format!("Provider returned HTTP {status}"));
    err.status = Some(status);
    err.body = Some(redact(&body, secret));
    err
}

/// Decode as much valid UTF-8 as possible, keeping an incomplete trailing
/// multi-byte sequence for the next chunk.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(err) if err.error_len().is_none() => {
            let valid = err.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

/// The bearer credential for a request: the stored API key, or for OpenAI
/// with `auth = "chatgpt"` a fresh Sign in with ChatGPT access token.
async fn credential_for(chatgpt: &ChatGptAuth, provider: &str, auth: Option<&str>) -> CmdResult<String> {
    match (provider, auth) {
        ("openai", Some("chatgpt")) => chatgpt::access_token(chatgpt).await,
        (_, None | Some("api_key")) => load_secret(provider).await,
        (_, Some(other)) => Err(CmdError::new("invalid_request", format!("Unsupported authentication method: {other}"))),
    }
}

async fn stream_inner(chatgpt: &ChatGptAuth, request: StreamRequest, channel: Channel<StreamEvent>) -> CmdResult<()> {
    let secret = credential_for(chatgpt, &request.provider, request.auth.as_deref()).await?;
    stream_with_secret(&request, &secret, |event| {
        channel
            .send(event)
            .map_err(|e| CmdError::new("cancelled", format!("Stream receiver closed: {e}")))
    })
    .await
}

async fn stream_with_secret(
    request: &StreamRequest,
    secret: &str,
    mut send: impl FnMut(StreamEvent) -> CmdResult<()>,
) -> CmdResult<()> {
    if !request.body.is_object() {
        return Err(CmdError::new("invalid_request", "Request body must be a JSON object"));
    }
    let url = endpoint(&request.provider, "POST", &request.path)?;
    let mut headers = auth_headers(&request.provider, secret)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));

    let response = client()?
        .post(url)
        .headers(headers)
        .json(&request.body)
        .send()
        .await
        .map_err(|e| network_error(e, secret))?;
    if !response.status().is_success() {
        return Err(http_error(response, secret).await);
    }
    send(StreamEvent::Open {
        status: response.status().as_u16(),
    })?;

    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let mut err = network_error(e, secret);
            err.kind = "stream_interrupted";
            err
        })?;
        pending.extend_from_slice(&chunk);
        let data = take_utf8(&mut pending);
        if !data.is_empty() {
            send(StreamEvent::Chunk { data })?;
        }
    }
    if !pending.is_empty() {
        send(StreamEvent::Chunk {
            data: String::from_utf8_lossy(&pending).into_owned(),
        })?;
    }
    send(StreamEvent::Done)
}

/// Stream a provider request. Resolves when the stream ends; chunks of the raw
/// response body are delivered through `on_event`.
#[tauri::command]
pub async fn ai_stream(
    state: State<'_, AiRequests>,
    chatgpt: State<'_, ChatGptAuth>,
    request: StreamRequest,
    on_event: Channel<StreamEvent>,
) -> CmdResult<()> {
    let id = request.request_id.clone();
    let cancel = Arc::new(Notify::new());
    state
        .0
        .lock()
        .map_err(|_| CmdError::new("internal", "request registry poisoned"))?
        .insert(id.clone(), cancel.clone());

    let result = tokio::select! {
        result = stream_inner(&chatgpt, request, on_event) => result,
        _ = cancel.notified() => Err(CmdError::new("cancelled", "Generation cancelled")),
    };

    if let Ok(mut map) = state.0.lock() {
        map.remove(&id);
    }
    result
}

/// Cancel an in-flight stream. Returns false when the request already ended.
#[tauri::command]
pub async fn ai_cancel(state: State<'_, AiRequests>, request_id: String) -> CmdResult<bool> {
    let map = state
        .0
        .lock()
        .map_err(|_| CmdError::new("internal", "request registry poisoned"))?;
    match map.get(&request_id) {
        Some(notify) => {
            notify.notify_one();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Non-streaming GET against an allowlisted provider endpoint (model listing,
/// connection test). Returns the parsed JSON body.
#[tauri::command]
pub async fn ai_get(
    chatgpt: State<'_, ChatGptAuth>,
    provider: String,
    path: String,
    auth: Option<String>,
) -> CmdResult<serde_json::Value> {
    let secret = credential_for(&chatgpt, &provider, auth.as_deref()).await?;
    get_with_secret(&provider, &path, &secret).await
}

async fn get_with_secret(provider: &str, path: &str, secret: &str) -> CmdResult<serde_json::Value> {
    let url = endpoint(provider, "GET", path)?;
    let headers = auth_headers(provider, secret)?;
    let response = client()?
        .get(url)
        .headers(headers)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| network_error(e, secret))?;
    if !response.status().is_success() {
        return Err(http_error(response, secret).await);
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| CmdError::new("malformed_response", redact(&e.to_string(), secret)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_are_allowlisted() {
        assert!(endpoint("openai", "POST", "/v1/responses").is_ok());
        assert!(endpoint("anthropic", "POST", "/v1/messages").is_ok());
        assert!(endpoint("openai", "POST", "/v1/files").is_err());
        assert!(endpoint("evil", "POST", "/v1/messages").is_err());
        assert_eq!(
            endpoint("anthropic", "GET", "/v1/models").unwrap(),
            "https://api.anthropic.com/v1/models?limit=1000"
        );
    }

    #[test]
    fn redacts_secrets() {
        let secret = "sk-ant-api03-SECRETSECRETSECRET";
        let text = format!("bad key {secret} and sk-proj-abcdefghijklmnop end");
        let out = redact(&text, secret);
        assert!(!out.contains("SECRET"));
        assert!(!out.contains("abcdefghijklmnop"));
        assert!(out.ends_with("end"));
    }

    /// Hits the real Anthropic API with an invalid key. Run with
    /// `cargo test -- --ignored` (needs network access).
    #[tokio::test]
    #[ignore]
    async fn anthropic_invalid_key_is_reported_and_redacted() {
        let secret = "sk-ant-api03-logica-invalid-test-key-0000000000";
        let request = StreamRequest {
            request_id: "test".into(),
            provider: "anthropic".into(),
            path: "/v1/messages".into(),
            auth: None,
            body: serde_json::json!({
                "model": "claude-haiku-5-5",
                "max_tokens": 16,
                "stream": true,
                "messages": [{ "role": "user", "content": "hi" }]
            }),
        };
        let err = stream_with_secret(&request, secret, |_| Ok(())).await.unwrap_err();
        assert_eq!(err.kind, "http_error");
        assert_eq!(err.status, Some(401));
        let body = err.body.unwrap_or_default();
        assert!(!body.contains("invalid-test-key"), "secret leaked: {body}");

        let err = get_with_secret("anthropic", "/v1/models", secret).await.unwrap_err();
        assert_eq!(err.status, Some(401));
    }

    #[test]
    fn utf8_split_across_chunks() {
        let bytes = "가".as_bytes();
        let mut pending = bytes[..2].to_vec();
        assert_eq!(take_utf8(&mut pending), "");
        pending.extend_from_slice(&bytes[2..]);
        assert_eq!(take_utf8(&mut pending), "가");
    }
}
