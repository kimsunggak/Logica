//! Persistence of non-secret application state (settings, last project,
//! cursor positions, panel sizes). Credentials are never stored here; they
//! live in the OS credential store (see `credentials.rs`).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{CmdError, CmdResult};

const STATE_FILE: &str = "state.json";
const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;

fn state_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| CmdError::new("io", format!("No config directory: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(STATE_FILE))
}

#[tauri::command]
pub async fn load_app_state(app: AppHandle) -> CmdResult<Option<serde_json::Value>> {
    let path = state_path(&app)?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    // A corrupted state file must not prevent the app from starting.
    Ok(serde_json::from_str(&text).ok())
}

#[tauri::command]
pub async fn save_app_state(app: AppHandle, state: serde_json::Value) -> CmdResult<()> {
    let text = serde_json::to_string_pretty(&state)
        .map_err(|e| CmdError::new("invalid_state", e.to_string()))?;
    if text.len() > MAX_STATE_BYTES {
        return Err(CmdError::new("invalid_state", "Application state is too large"));
    }
    let path = state_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
