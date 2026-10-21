//! The paper report, kept on this computer only:
//!
//! ```text
//! <app local data>/papers/<project id>/report.json
//! ```
//!
//! It holds one summary per section of the paper, `{ version, summaries }`,
//! written by the chat's Section Summary Module and not interpreted here.
//! The project id is the same hash as for the chat history (`chats.rs`), so
//! every chat session of a project reads the same report.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::chats::{base_dir, project_id};
use crate::error::{CmdError, CmdResult};

const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;

fn report_path(base: &Path, root: &str) -> PathBuf {
    base.join("papers").join(project_id(root)).join("report.json")
}

fn load(path: &Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save(path: &Path, root: &str, report: &serde_json::Value) -> CmdResult<()> {
    if !report.is_object() || !report["summaries"].is_object() {
        return Err(CmdError::new("invalid_request", "A paper report needs a summaries object"));
    }
    let text = serde_json::to_string(report).map_err(|e| CmdError::new("invalid_request", e.to_string()))?;
    if text.len() > MAX_REPORT_BYTES {
        return Err(CmdError::new("too_large", "The paper report is too large to save"));
    }
    let dir = path.parent().ok_or_else(|| CmdError::new("internal", "No folder for the paper report"))?;
    std::fs::create_dir_all(dir)?;
    // Which folder a hashed directory belongs to, for anyone looking at the files.
    let marker = dir.join("project.json");
    if !marker.exists() {
        std::fs::write(&marker, serde_json::json!({ "root": root }).to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub async fn paper_load_report(app: AppHandle, root: String) -> CmdResult<Option<serde_json::Value>> {
    Ok(load(&report_path(&base_dir(&app)?, &root)))
}

#[tauri::command]
pub async fn paper_save_report(app: AppHandle, root: String, report: serde_json::Value) -> CmdResult<()> {
    save(&report_path(&base_dir(&app)?, &root), &root, &report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(summary: &str) -> serde_json::Value {
        serde_json::json!({ "version": 1, "summaries": { "00ab": { "title": "Method", "summary": summary, "updatedAt": 1 } } })
    }

    #[test]
    fn saves_and_loads_one_report_per_project() {
        let base = std::env::temp_dir().join(format!("logica-papers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let a = report_path(&base, "/papers/a");
        assert!(load(&a).is_none());
        save(&a, "/papers/a", &report("Routes joints.")).unwrap();
        save(&a, "/papers/a", &report("Routes each joint.")).unwrap();
        assert_eq!(load(&a).unwrap()["summaries"]["00ab"]["summary"], "Routes each joint.");
        assert!(a.parent().unwrap().join("project.json").is_file());
        // Another project has its own report.
        assert!(load(&report_path(&base, "/papers/b")).is_none());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_a_report_without_summaries() {
        let base = std::env::temp_dir().join(format!("logica-papers-bad-{}", std::process::id()));
        let path = report_path(&base, "/p");
        assert!(save(&path, "/p", &serde_json::json!({ "version": 1 })).is_err());
        assert!(save(&path, "/p", &serde_json::json!([])).is_err());
        assert!(!path.exists());
    }
}
