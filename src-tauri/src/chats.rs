//! Chat history, kept on this computer only:
//!
//! ```text
//! <app local data>/chats/<project id>/<session id>.json
//! ```
//!
//! `<app local data>` is `%LOCALAPPDATA%\app.logica.desktop` on Windows. The
//! project id is a hash of the project folder path, so moving or renaming a
//! folder starts a new history. Each session file holds
//! `{ version, createdAt, updatedAt, messages }`; the messages are whatever
//! the chat panel stores and are not interpreted here.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{CmdError, CmdResult};

const MAX_SESSION_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    /// The first question of the conversation, shortened.
    title: String,
    created_at: u64,
    updated_at: u64,
    message_count: usize,
}

/// Stable id of a project folder: SHA-256 of its canonical path (32 hex chars).
pub(crate) fn project_id(root: &str) -> String {
    let path = std::fs::canonicalize(root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| root.to_string());
    let digest = Sha256::digest(path.as_bytes());
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

/// Session ids come from the webview: allow only simple names, never paths.
fn check_session_id(id: &str) -> CmdResult<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(CmdError::new("invalid_request", "Invalid chat session id"))
    }
}

fn chats_dir(base: &Path, root: &str) -> PathBuf {
    base.join("chats").join(project_id(root))
}

pub(crate) fn base_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_local_data_dir().map_err(|e| CmdError::new("io", format!("No local data directory: {e}")))
}

fn title_of(session: &serde_json::Value) -> String {
    let first = session["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["role"] == "user"))
        .and_then(|m| m["content"].as_str())
        .unwrap_or("");
    let line = first.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(60).collect::<String>())
    } else {
        line
    }
}

fn list(dir: &Path) -> Vec<SessionSummary> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions: Vec<SessionSummary> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?.to_string();
            if path.extension()? != "json" || check_session_id(&id).is_err() {
                return None;
            }
            // A damaged file is skipped rather than breaking the whole list.
            let session: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
            session["messages"].as_array()?; // skips project.json and foreign files
            Some(SessionSummary {
                title: title_of(&session),
                created_at: session["createdAt"].as_u64().unwrap_or(0),
                updated_at: session["updatedAt"].as_u64().unwrap_or(0),
                message_count: session["messages"].as_array().map_or(0, Vec::len),
                id,
            })
        })
        .collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    sessions
}

fn save(dir: &Path, root: &str, id: &str, session: &serde_json::Value) -> CmdResult<()> {
    check_session_id(id)?;
    if !session.is_object() || !session["messages"].is_array() {
        return Err(CmdError::new("invalid_request", "A chat session needs a messages array"));
    }
    let text = serde_json::to_string(session).map_err(|e| CmdError::new("invalid_request", e.to_string()))?;
    if text.len() > MAX_SESSION_BYTES {
        return Err(CmdError::new("too_large", "This conversation is too long to save"));
    }
    std::fs::create_dir_all(dir)?;
    // Which folder a hashed directory belongs to, for anyone looking at the files.
    let marker = dir.join("project.json");
    if !marker.exists() {
        std::fs::write(&marker, serde_json::json!({ "root": root }).to_string())?;
    }
    let path = dir.join(format!("{id}.json"));
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub async fn chat_list_sessions(app: AppHandle, root: String) -> CmdResult<Vec<SessionSummary>> {
    let dir = chats_dir(&base_dir(&app)?, &root);
    tauri::async_runtime::spawn_blocking(move || list(&dir))
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn chat_load_session(app: AppHandle, root: String, id: String) -> CmdResult<Option<serde_json::Value>> {
    check_session_id(&id)?;
    let path = chats_dir(&base_dir(&app)?, &root).join(format!("{id}.json"));
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    Ok(serde_json::from_slice(&bytes).ok())
}

#[tauri::command]
pub async fn chat_save_session(app: AppHandle, root: String, id: String, session: serde_json::Value) -> CmdResult<()> {
    let dir = chats_dir(&base_dir(&app)?, &root);
    save(&dir, &root, &id, &session)
}

#[tauri::command]
pub async fn chat_delete_session(app: AppHandle, root: String, id: String) -> CmdResult<()> {
    check_session_id(&id)?;
    let path = chats_dir(&base_dir(&app)?, &root).join(format!("{id}.json"));
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(question: &str, updated_at: u64) -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "createdAt": 1,
            "updatedAt": updated_at,
            "messages": [
                { "role": "user", "content": question },
                { "role": "assistant", "content": "answer" }
            ]
        })
    }

    #[test]
    fn saves_lists_and_deletes_sessions_per_project() {
        let base = std::env::temp_dir().join(format!("logica-chats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = chats_dir(&base, "/papers/a");
        save(&dir, "/papers/a", "s1", &session("Make the intro shorter", 10)).unwrap();
        save(&dir, "/papers/a", "s2", &session(&"long ".repeat(40), 20)).unwrap();
        let sessions = list(&dir);
        assert_eq!(sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s2", "s1"]);
        assert_eq!(sessions[1].title, "Make the intro shorter");
        assert!(sessions[0].title.ends_with('…'));
        assert_eq!(sessions[0].message_count, 2);
        assert!(dir.join("project.json").is_file());
        // Another project has its own folder.
        assert!(list(&chats_dir(&base, "/papers/b")).is_empty());
        std::fs::remove_file(dir.join("s1.json")).unwrap();
        assert_eq!(list(&dir).len(), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_ids_that_could_escape_the_folder() {
        for id in ["../x", "a/b", "a\\b", "", "..", &"x".repeat(65)] {
            assert!(check_session_id(id).is_err(), "{id}");
        }
        assert!(check_session_id("0b9e-41f2_x").is_ok());
        let base = std::env::temp_dir();
        assert!(save(&chats_dir(&base, "/p"), "/p", "../evil", &session("q", 1)).is_err());
    }

    #[test]
    fn project_ids_are_stable_hashes() {
        assert_eq!(project_id("/no/such/folder"), project_id("/no/such/folder"));
        assert_ne!(project_id("/no/such/a"), project_id("/no/such/b"));
        assert_eq!(project_id("/no/such/a").len(), 32);
    }
}
