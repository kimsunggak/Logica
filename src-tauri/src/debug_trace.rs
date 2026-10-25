//! Runtime trace events for the visual debugger (debug builds only).
//!
//! The chat pipeline in the webview reports its steps through `debug_trace`,
//! and the AI transport (`ai.rs`) reports the provider requests it runs for
//! them. Every event is redacted here, printed to the terminal and pushed over
//! Server-Sent Events to a standalone page at http://127.0.0.1:1430
//! (`LOGICA_DEBUG_PORT` changes the port). Release builds start no server and
//! drop every event.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::State;
use tokio::sync::broadcast;

/// Events replayed to a page that connects late.
const HISTORY_EVENTS: usize = 4000;
/// Longest string kept in an event (a full paper prompt fits).
const MAX_STRING: usize = 400_000;

struct HubState {
    seq: u64,
    history: VecDeque<String>,
    /// Provider request id -> (trace id, span id) of the webview call that started it.
    links: HashMap<String, (String, String)>,
    /// Trace id -> start time, for the relative times in the terminal log.
    started: HashMap<String, u64>,
    /// Active project and its fixed application-managed summary path.
    paper: Option<(String, std::path::PathBuf)>,
}

struct Inner {
    enabled: bool,
    tx: broadcast::Sender<String>,
    state: Mutex<HubState>,
}

/// Collects trace events and fans them out to the terminal and the debug page.
#[derive(Clone)]
pub struct DebugHub(Arc<Inner>);

impl Default for DebugHub {
    fn default() -> Self {
        Self::new(cfg!(debug_assertions))
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl DebugHub {
    pub fn new(enabled: bool) -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self(Arc::new(Inner {
            enabled,
            tx,
            state: Mutex::new(HubState {
                seq: 0,
                history: VecDeque::new(),
                links: HashMap::new(),
                started: HashMap::new(),
                paper: None,
            }),
        }))
    }

    pub fn enabled(&self) -> bool {
        self.0.enabled
    }

    fn set_paper(&self, paper: Option<(String, std::path::PathBuf)>) {
        if self.enabled() {
            if let Ok(mut state) = self.0.state.lock() {
                state.paper = paper;
            }
        }
    }

    fn paper_summary(&self) -> Value {
        let paper = match self.0.state.lock() {
            Ok(state) => state.paper.clone(),
            Err(_) => return json!({ "status": "error", "error": "Could not read the active project" }),
        };
        match paper {
            Some((root, path)) => crate::papers::inspect_summary(&path, &root),
            None => json!({ "status": "no_project", "project": null, "path": null, "text": null }),
        }
    }

    /// Redact, number, log and broadcast one event.
    pub fn emit(&self, mut event: Value) {
        if !self.0.enabled {
            return;
        }
        redact_value(&mut event, None);
        let Some(obj) = event.as_object_mut() else { return };
        obj.entry("timestamp").or_insert_with(|| json!(now_ms()));
        let line;
        let relative;
        {
            let Ok(mut state) = self.0.state.lock() else { return };
            state.seq += 1;
            obj.insert("seq".into(), json!(state.seq));
            let trace = str_field(obj, "trace_id").to_string();
            let ts = obj.get("timestamp").and_then(Value::as_u64).unwrap_or(0);
            let start = *state.started.entry(trace.clone()).or_insert(ts);
            relative = ts.saturating_sub(start);
            if str_field(obj, "event_type") == "span_start" {
                let request = str_field(obj, "request_id");
                if !request.is_empty() && str_field(obj, "source") == "webview" {
                    let span = str_field(obj, "span_id").to_string();
                    state.links.insert(request.to_string(), (trace.clone(), span));
                }
            }
            line = Value::Object(obj.clone()).to_string();
            state.history.push_back(line.clone());
            while state.history.len() > HISTORY_EVENTS {
                state.history.pop_front();
            }
            if state.started.len() > 200 {
                state.started.clear();
            }
        }
        println!("{}", cli_line(obj, relative));
        let _ = self.0.tx.send(line);
    }

    /// The webview trace a provider request belongs to, if it is traced.
    pub fn link(&self, request_id: &str) -> Option<(String, String)> {
        if !self.0.enabled {
            return None;
        }
        self.0.state.lock().ok()?.links.get(request_id).cloned()
    }

    pub fn unlink(&self, request_id: &str) {
        if let Ok(mut state) = self.0.state.lock() {
            state.links.remove(request_id);
        }
    }

    #[cfg(debug_assertions)]
    fn subscribe(&self) -> (Vec<String>, broadcast::Receiver<String>) {
        // Subscribe before copying the history so no event falls in between;
        // the page drops duplicates by `seq`.
        let rx = self.0.tx.subscribe();
        let history = self.0.state.lock().map(|s| s.history.iter().cloned().collect()).unwrap_or_default();
        (history, rx)
    }
}

fn str_field<'a>(obj: &'a Map<String, Value>, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `[trace 3f2a +0.183s] orchestrator  runOrchestrator  completed (177 ms)`
fn cli_line(obj: &Map<String, Value>, relative_ms: u64) -> String {
    let trace = str_field(obj, "trace_id");
    let short = &trace[trace.len().saturating_sub(4)..];
    let duration = obj
        .get("duration_ms")
        .and_then(Value::as_f64)
        .map(|d| format!(" ({d:.0} ms)"))
        .unwrap_or_default();
    let error = obj.get("error").and_then(Value::as_str).map(|e| format!(": {e}")).unwrap_or_default();
    format!(
        "[trace {short} +{:.3}s] {:<7} {:<22} {}{duration}{error}",
        relative_ms as f64 / 1000.0,
        str_field(obj, "module"),
        str_field(obj, "function"),
        match str_field(obj, "event_type") {
            "span_start" => "started",
            "span_end" => "completed",
            "span_error" => "error",
            "span_data" => "data",
            other => other,
        },
    )
}

// ---------------------------------------------------------------- redaction

/// Whether a JSON key names a secret. `inputTokens` (a count) is not one.
fn sensitive_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase().replace('-', "_");
    k.ends_with("token")
        || k.contains("secret")
        || k.contains("password")
        || k.contains("api_key")
        || k.contains("apikey")
        || k.contains("credential")
        || k.contains("cookie")
        || k == "authorization"
}

fn is_token_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'.'
}

/// Mask secret-looking substrings: `sk-...` keys, `Bearer ...` values and JWTs (`eyJ...`).
pub fn mask_secrets(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let rest = &text[i..];
        // Only at the start of a word: "risk-assessment" is prose, not a key.
        let word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let prefix = if !word_start {
            None
        } else if rest.starts_with("sk-") {
            Some(3)
        } else if rest.starts_with("Bearer ") {
            Some(7)
        } else if rest.starts_with("eyJ") {
            Some(0)
        } else {
            None
        };
        if let Some(skip) = prefix {
            let start = i + skip;
            let mut end = start;
            while end < bytes.len() && is_token_char(bytes[end]) {
                end += 1;
            }
            let token = &text[start..end];
            let jwt = skip == 0 && token.matches('.').count() >= 2 && token.len() >= 20;
            if (skip > 0 && end - start >= 8) || jwt {
                out.push_str(&text[i..start]);
                out.push_str("***");
                i = end;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn truncate(text: String) -> String {
    if text.len() <= MAX_STRING {
        return text;
    }
    let mut cut = MAX_STRING;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}… [{} more bytes]", &text[..cut], text.len() - cut)
}

/// Redact secrets anywhere in an event before it is logged or sent.
pub fn redact_value(value: &mut Value, key: Option<&str>) {
    if key.is_some_and(sensitive_key) && !value.is_null() && !value.is_number() && !value.is_boolean() {
        *value = json!("***");
        return;
    }
    match value {
        Value::String(s) => *s = truncate(mask_secrets(s)),
        Value::Array(items) => items.iter_mut().for_each(|v| redact_value(v, None)),
        Value::Object(map) => map.iter_mut().for_each(|(k, v)| redact_value(v, Some(k))),
        _ => {}
    }
}

// ---------------------------------------------------------------- command

/// Pipeline event reported by the webview (dropped in release builds).
#[tauri::command]
pub fn debug_trace(hub: State<'_, DebugHub>, event: Value) {
    if hub.enabled() {
        let mut event = event;
        if let Some(obj) = event.as_object_mut() {
            obj.insert("source".into(), json!("webview"));
        }
        hub.emit(event);
    }
}

// ---------------------------------------------------------------- server

/// Track the open project before its first question, and clear it on returning home.
#[tauri::command]
pub fn debug_project(app: tauri::AppHandle, hub: State<'_, DebugHub>, root: Option<String>) -> crate::error::CmdResult<()> {
    if !hub.enabled() {
        return Ok(());
    }
    let paper = match root {
        Some(root) => {
            let path = crate::papers::summary_path(&crate::chats::base_dir(&app)?, &root);
            Some((root, path))
        }
        None => None,
    };
    hub.set_paper(paper);
    Ok(())
}

#[cfg(debug_assertions)]
pub use server::start;

#[cfg(not(debug_assertions))]
pub fn start(_hub: DebugHub) {}

#[cfg(debug_assertions)]
mod server {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::broadcast::error::RecvError;

    use super::DebugHub;

    const DEFAULT_PORT: u16 = 1430;
    const PAGE: &str = include_str!("../debug/visualizer.html");
    const MAX_HEAD: usize = 8 * 1024;

    pub fn port() -> u16 {
        std::env::var("LOGICA_DEBUG_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT)
    }

    /// Serve the debug page on 127.0.0.1 in the background.
    pub fn start(hub: DebugHub) {
        let port = port();
        tauri::async_runtime::spawn(async move {
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => {
                    println!("\n  LOGICA debug visualizer: http://127.0.0.1:{port}\n");
                    serve(listener, hub, port).await;
                }
                Err(e) => eprintln!("LOGICA debug visualizer could not start on port {port}: {e}"),
            }
        });
    }

    pub(super) async fn serve(listener: TcpListener, hub: DebugHub, port: u16) {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let hub = hub.clone();
            tokio::spawn(async move {
                let _ = handle(stream, hub, port).await;
            });
        }
    }

    /// Only the loopback names of this port are served (blocks DNS rebinding).
    pub(super) fn allowed_host(host: Option<&str>, port: u16) -> bool {
        let Some(host) = host else { return false };
        [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")]
            .iter()
            .any(|h| h.eq_ignore_ascii_case(host))
    }

    pub(super) struct Head {
        pub method: String,
        pub path: String,
        pub host: Option<String>,
    }

    pub(super) fn parse_head(head: &str) -> Option<Head> {
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split_whitespace();
        let method = first.next()?.to_string();
        let target = first.next()?;
        let path = target.split('?').next().unwrap_or("/").to_string();
        let host = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
            .map(|(_, v)| v.trim().to_string());
        Some(Head { method, path, host })
    }

    async fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) -> std::io::Result<()> {
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(body.as_bytes()).await?;
        stream.shutdown().await
    }

    async fn handle(mut stream: TcpStream, hub: DebugHub, port: u16) -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > MAX_HEAD {
                return respond(&mut stream, "431 Request Header Fields Too Large", "text/plain", "").await;
            }
        }
        let Some(head) = parse_head(&String::from_utf8_lossy(&buf)) else {
            return respond(&mut stream, "400 Bad Request", "text/plain", "").await;
        };
        if !allowed_host(head.host.as_deref(), port) {
            return respond(&mut stream, "403 Forbidden", "text/plain", "Open http://127.0.0.1 instead.").await;
        }
        if head.method != "GET" {
            return respond(&mut stream, "405 Method Not Allowed", "text/plain", "").await;
        }
        match head.path.as_str() {
            "/" => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE).await,
            "/health" => respond(&mut stream, "200 OK", "text/plain", "ok").await,
            "/paper-summary" => respond(&mut stream, "200 OK", "application/json; charset=utf-8", &hub.paper_summary().to_string()).await,
            "/events" => events(stream, hub).await,
            _ => respond(&mut stream, "404 Not Found", "text/plain", "").await,
        }
    }

    /// Server-Sent Events: the stored history first, then every new event.
    async fn events(mut stream: TcpStream, hub: DebugHub) -> std::io::Result<()> {
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\nretry: 1000\n\n")
            .await?;
        let (history, mut rx) = hub.subscribe();
        for line in history {
            stream.write_all(format!("data: {line}\n\n").as_bytes()).await?;
        }
        loop {
            tokio::select! {
                next = rx.recv() => match next {
                    Ok(line) => stream.write_all(format!("data: {line}\n\n").as_bytes()).await?,
                    // A slow page missed events; it reconnects and replays the history.
                    Err(RecvError::Lagged(_)) => return Ok(()),
                    Err(RecvError::Closed) => return Ok(()),
                },
                _ = tokio::time::sleep(Duration::from_secs(15)) => stream.write_all(b": ping\n\n").await?,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_keys_bearer_values_and_jwts() {
        let text = "key sk-ant-api03-ABCDEFGHIJ, header Bearer abc.def-123456 and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_value ok";
        let out = mask_secrets(text);
        assert!(!out.contains("ABCDEFGHIJ"));
        assert!(!out.contains("abc.def-123456"));
        assert!(!out.contains("eyJzdWIiOiIxIn0"));
        assert!(out.ends_with(" ok"));
        // Ordinary words that merely start the same way stay.
        assert_eq!(mask_secrets("sk-x ask-me eyJ"), "sk-x ask-me eyJ");
        assert_eq!(mask_secrets("가나다 sk-short"), "가나다 sk-short");
        assert_eq!(mask_secrets("a risk-assessment task-management"), "a risk-assessment task-management");
    }

    #[test]
    fn redacts_secret_keys_but_keeps_token_counts() {
        let mut event = json!({
            "input": { "access_token": "abc", "refresh_token": "def", "api_key": "k", "Authorization": "x", "inputTokens": 12 },
            "output": { "usage": { "outputTokens": 3 }, "text": "uses sk-proj-0123456789abcdef" }
        });
        redact_value(&mut event, None);
        assert_eq!(event["input"]["access_token"], "***");
        assert_eq!(event["input"]["refresh_token"], "***");
        assert_eq!(event["input"]["api_key"], "***");
        assert_eq!(event["input"]["Authorization"], "***");
        assert_eq!(event["input"]["inputTokens"], 12);
        assert_eq!(event["output"]["usage"]["outputTokens"], 3);
        assert_eq!(event["output"]["text"], "uses sk-***");
    }

    #[test]
    fn links_provider_requests_to_webview_spans() {
        let hub = DebugHub::new(true);
        hub.emit(json!({ "trace_id": "t1", "span_id": "s2", "event_type": "span_start", "source": "webview", "request_id": "req-1" }));
        assert_eq!(hub.link("req-1"), Some(("t1".into(), "s2".into())));
        hub.unlink("req-1");
        assert_eq!(hub.link("req-1"), None);
        assert_eq!(DebugHub::new(false).link("req-1"), None);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn numbers_events_and_keeps_history() {
        let hub = DebugHub::new(true);
        hub.emit(json!({ "trace_id": "t", "event_type": "span_start" }));
        hub.emit(json!({ "trace_id": "t", "event_type": "span_end" }));
        let (history, _) = hub.subscribe();
        assert_eq!(history.len(), 2);
        assert!(history[1].contains("\"seq\":2"));
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn streams_events_to_the_page() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        let hub = DebugHub::new(true);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(super::server::serve(listener, hub.clone(), port));
        hub.emit(json!({ "trace_id": "t1", "span_id": "a", "event_type": "span_start", "module": "orchestrator", "function": "runOrchestrator", "input": "key sk-ant-api03-SECRETSECRET" }));

        let get = |path: &'static str, host: String| async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes()).await.unwrap();
            stream
        };
        let mut page = get("/", format!("127.0.0.1:{port}")).await;
        let mut html = String::new();
        page.read_to_string(&mut html).await.unwrap();
        assert!(html.starts_with("HTTP/1.1 200 OK"));
        assert!(html.contains("LOGICA Runtime Debugger"));

        let mut events = get("/events", format!("localhost:{port}")).await;
        let mut seen = String::new();
        let mut buf = [0u8; 4096];
        // History replay, then a live event.
        while !seen.contains("runOrchestrator") {
            let n = events.read(&mut buf).await.unwrap();
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        hub.emit(json!({ "trace_id": "t1", "span_id": "a", "event_type": "span_end", "module": "orchestrator", "function": "chooseRoute" }));
        while !seen.contains("chooseRoute") {
            let n = events.read(&mut buf).await.unwrap();
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        assert!(seen.contains("text/event-stream"));
        assert!(!seen.contains("SECRETSECRET"));

        let mut rebinding = get("/events", format!("attacker.example:{port}")).await;
        let mut denied = String::new();
        rebinding.read_to_string(&mut denied).await.unwrap();
        assert!(denied.starts_with("HTTP/1.1 403"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn serves_only_loopback_hosts() {
        use super::server::{allowed_host, parse_head};
        let head = parse_head("GET /events?x=1 HTTP/1.1\r\nHost: 127.0.0.1:1430\r\nAccept: */*\r\n\r\n").unwrap();
        assert_eq!(head.method, "GET");
        assert_eq!(head.path, "/events");
        assert!(allowed_host(head.host.as_deref(), 1430));
        assert!(allowed_host(Some("localhost:1430"), 1430));
        assert!(!allowed_host(Some("evil.example:1430"), 1430));
        assert!(!allowed_host(Some("127.0.0.1:9999"), 1430));
        assert!(!allowed_host(None, 1430));
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn inspects_the_active_projects_file_before_and_after_it_is_saved() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        let base = std::env::temp_dir().join(format!("logica-debug-paper-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let path = crate::papers::summary_path(&base, "/paper-a");
        let hub = DebugHub::new(true);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(super::server::serve(listener, hub.clone(), port));
        let get = || async {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream.write_all(format!("GET /paper-summary HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            assert!(response.starts_with("HTTP/1.1 200 OK"));
            serde_json::from_str::<Value>(response.split_once("\r\n\r\n").unwrap().1).unwrap()
        };
        assert_eq!(get().await["status"], "no_project");
        hub.set_paper(Some(("/paper-a".into(), path.clone())));
        assert_eq!(get().await["status"], "missing");
        assert!(!base.exists());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "sections:\n  - summary: 첫 요약\n").unwrap();
        assert_eq!(get().await["text"], "sections:\n  - summary: 첫 요약\n");
        std::fs::write(&path, "sections:\n  - summary: 수정한 요약\n").unwrap();
        assert_eq!(get().await["text"], "sections:\n  - summary: 수정한 요약\n");
        hub.set_paper(Some(("/paper-b".into(), crate::papers::summary_path(&base, "/paper-b"))));
        let next = get().await;
        assert_eq!(next["status"], "missing");
        assert_eq!(next["project"], "/paper-b");
        hub.set_paper(None);
        assert_eq!(get().await["status"], "no_project");
        std::fs::remove_dir_all(base).unwrap();
    }
}
