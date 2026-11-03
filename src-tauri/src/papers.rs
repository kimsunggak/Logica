//! The paper summary, kept on this computer only:
//!
//! ```text
//! <app local data>/papers/<project id>/paper-summary.yaml
//! ```
//!
//! It is a YAML document with one short summary per section of the paper,
//! in reading order, written by the chat's Paper Summary Module and not
//! interpreted here. The project id is the same hash as for the chat history
//! (`chats.rs`), so every chat session of a project reads the same summary.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::chats::{base_dir, project_id};
use crate::error::{CmdError, CmdResult};

const MAX_SUMMARY_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn summary_path(base: &Path, root: &str) -> PathBuf {
    base.join("papers").join(project_id(root)).join("paper-summary.yaml")
}

fn load(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Read the saved file afresh for the debugger; never create or summarize it.
pub(crate) fn inspect_summary(path: &Path, root: &str) -> serde_json::Value {
    let mut snapshot = serde_json::json!({ "project": root, "path": path.to_string_lossy(), "text": null });
    match std::fs::read_to_string(path) {
        Ok(text) => {
            snapshot["status"] = "ready".into();
            snapshot["text"] = text.into();
            if let Ok(modified) = std::fs::metadata(path).and_then(|m| m.modified()) {
                if let Ok(age) = modified.duration_since(std::time::UNIX_EPOCH) {
                    snapshot["modified_at"] = serde_json::json!(age.as_millis() as u64);
                }
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => snapshot["status"] = "missing".into(),
        Err(err) => {
            snapshot["status"] = "error".into();
            snapshot["error"] = err.to_string().into();
        }
    }
    snapshot
}

fn save(path: &Path, root: &str, text: &str) -> CmdResult<()> {
    if text.trim().is_empty() {
        return Err(CmdError::new("invalid_request", "The paper summary is empty"));
    }
    if text.len() > MAX_SUMMARY_BYTES {
        return Err(CmdError::new("too_large", "The paper summary is too large to save"));
    }
    let dir = path.parent().ok_or_else(|| CmdError::new("internal", "No folder for the paper summary"))?;
    std::fs::create_dir_all(dir)?;
    // Which folder a hashed directory belongs to, for anyone looking at the files.
    let marker = dir.join("project.json");
    if !marker.exists() {
        std::fs::write(&marker, serde_json::json!({ "root": root }).to_string())?;
    }
    let tmp = path.with_extension("yaml.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub async fn paper_load_summary(app: AppHandle, root: String) -> CmdResult<Option<String>> {
    Ok(load(&summary_path(&base_dir(&app)?, &root)))
}

#[tauri::command]
pub async fn paper_save_summary(app: AppHandle, root: String, text: String) -> CmdResult<()> {
    save(&summary_path(&base_dir(&app)?, &root), &root, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_one_summary_per_project() {
        let base = std::env::temp_dir().join(format!("logica-papers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let a = summary_path(&base, "/papers/a");
        assert!(load(&a).is_none());
        save(&a, "/papers/a", "version: 1\nsections: []\n").unwrap();
        save(&a, "/papers/a", "version: 1\nsections:\n  - key: abstract\n").unwrap();
        assert_eq!(load(&a).unwrap(), "version: 1\nsections:\n  - key: abstract\n");
        assert!(a.ends_with("paper-summary.yaml"));
        assert!(a.parent().unwrap().join("project.json").is_file());
        // Another project has its own summary.
        assert!(load(&summary_path(&base, "/papers/b")).is_none());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_an_empty_summary() {
        let base = std::env::temp_dir().join(format!("logica-papers-empty-{}", std::process::id()));
        let path = summary_path(&base, "/p");
        assert!(save(&path, "/p", "  \n").is_err());
        assert!(!path.exists());
    }

    #[test]
    fn inspector_observes_missing_created_and_updated_files_without_writing() {
        let base = std::env::temp_dir().join(format!("logica-papers-inspect-{}", std::process::id()));
        let path = summary_path(&base, "/inspect");
        let _ = std::fs::remove_dir_all(&base);
        let missing = inspect_summary(&path, "/inspect");
        assert_eq!(missing["status"], "missing");
        assert!(missing["text"].is_null());
        assert!(!base.exists());
        save(&path, "/inspect", "version: 1\nsections: []\n").unwrap();
        let ready = inspect_summary(&path, "/inspect");
        assert_eq!(ready["status"], "ready");
        assert_eq!(ready["text"], "version: 1\nsections: []\n");
        assert_eq!(ready["project"], "/inspect");
        assert!(ready["path"].as_str().unwrap().ends_with("paper-summary.yaml"));
        save(&path, "/inspect", "version: 1\nsections:\n  - summary: 요약\n").unwrap();
        assert_eq!(inspect_summary(&path, "/inspect")["text"], "version: 1\nsections:\n  - summary: 요약\n");
        // A read failure must not be mistaken for a file that does not exist.
        assert_eq!(inspect_summary(&base, "/inspect")["status"], "error");
        std::fs::remove_dir_all(base).unwrap();
    }
}
