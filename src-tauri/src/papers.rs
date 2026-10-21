//! The paper summary, kept on this computer only:
//!
//! ```text
//! <app local data>/papers/<project id>/paper-summary.yaml
//! ```
//!
//! It is a YAML document with one short summary per section of the paper,
//! in reading order, written by the chat's Section Summary Module and not
//! interpreted here. The project id is the same hash as for the chat history
//! (`chats.rs`), so every chat session of a project reads the same summary.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::chats::{base_dir, project_id};
use crate::error::{CmdError, CmdResult};

const MAX_SUMMARY_BYTES: usize = 4 * 1024 * 1024;

fn summary_path(base: &Path, root: &str) -> PathBuf {
    base.join("papers").join(project_id(root)).join("paper-summary.yaml")
}

fn load(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
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
}
