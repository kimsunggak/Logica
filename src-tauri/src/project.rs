//! Sandboxed access to the files of the opened LaTeX project.
//!
//! Every command takes the project root and a project-relative path. Paths are
//! resolved and checked so that a command can never read or write outside the
//! project folder (no absolute paths, no `..`, no symlink escapes).

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::Response;

use crate::error::{CmdError, CmdResult};

const MAX_LISTED_ENTRIES: usize = 5000;
const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 300 * 1024 * 1024;

/// Directories that never contain paper sources.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "_minted",
    "__pycache__",
    "build",
    "out",
];

/// File types shown in the project explorer.
const LISTED_EXTENSIONS: &[&str] = &["tex", "bib", "sty", "cls", "bbx", "cbx", "txt", "md"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    path: String,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListing {
    root: String,
    entries: Vec<ProjectEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    content: String,
    mtime: u64,
    /// True when the file was not valid UTF-8 and had to be decoded lossily.
    lossy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    path: String,
    /// `None` when the file no longer exists.
    mtime: Option<u64>,
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn canonical_root(root: &str) -> CmdResult<PathBuf> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|e| CmdError::new("not_found", format!("Project folder not found: {e}")))?;
    if !path.is_dir() {
        return Err(CmdError::new("not_found", "Project path is not a folder"));
    }
    Ok(path)
}

/// Resolve a project-relative path to an absolute path inside `root`.
pub fn resolve(root: &Path, rel: &str) -> CmdResult<PathBuf> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || rel_path.is_absolute() {
        return Err(CmdError::new("invalid_path", format!("Invalid project path: {rel}")));
    }
    for component in rel_path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => {
                return Err(CmdError::new(
                    "invalid_path",
                    format!("Path leaves the project folder: {rel}"),
                ))
            }
        }
    }
    let joined = root.join(rel_path);
    // Follow symlinks for existing paths so a link cannot point outside the project.
    let checked = if joined.exists() {
        joined.canonicalize()?
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| CmdError::new("invalid_path", "Path has no parent"))?
            .canonicalize()?;
        let name = joined
            .file_name()
            .ok_or_else(|| CmdError::new("invalid_path", "Path has no file name"))?;
        parent.join(name)
    };
    if !checked.starts_with(root) {
        return Err(CmdError::new(
            "invalid_path",
            format!("Path leaves the project folder: {rel}"),
        ));
    }
    Ok(checked)
}

fn to_rel_string(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<ProjectEntry>) -> bool {
    if depth > 12 {
        return false;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut children: Vec<_> = read_dir.flatten().collect();
    children.sort_by_key(|e| e.file_name());
    for entry in children {
        if out.len() >= MAX_LISTED_ENTRIES {
            return true;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if walk(root, &path, depth + 1, out) {
                return true;
            }
        } else if file_type.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !LISTED_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if let Some(rel) = to_rel_string(root, &path) {
                out.push(ProjectEntry {
                    path: rel,
                    size: meta.len(),
                    mtime: mtime_ms(&meta),
                });
            }
        }
    }
    false
}

#[tauri::command]
pub async fn list_project_files(root: String) -> CmdResult<ProjectListing> {
    let root_path = canonical_root(&root)?;
    let mut entries = Vec::new();
    let truncated = walk(&root_path, &root_path, 0, &mut entries);
    Ok(ProjectListing {
        root: root_path.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn read_text_file(root: String, path: String) -> CmdResult<TextFile> {
    let root_path = canonical_root(&root)?;
    let file = resolve(&root_path, &path)?;
    let meta = std::fs::metadata(&file)?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(CmdError::new("too_large", format!("{path} is too large to edit")));
    }
    let bytes = std::fs::read(&file)?;
    let (content, lossy) = match String::from_utf8(bytes) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
    };
    Ok(TextFile {
        content,
        mtime: mtime_ms(&meta),
        lossy,
    })
}

/// Write a text file atomically.
///
/// When `expected_mtime` is given and the file on disk has a different
/// modification time, the write is refused with kind `conflict` unless `force`
/// is set. This protects against silently overwriting external edits.
#[tauri::command]
pub async fn write_text_file(
    root: String,
    path: String,
    content: String,
    expected_mtime: Option<u64>,
    force: Option<bool>,
) -> CmdResult<WriteResult> {
    let root_path = canonical_root(&root)?;
    let file = resolve(&root_path, &path)?;
    let existing = std::fs::metadata(&file).ok();
    if let (Some(meta), Some(expected), false) = (&existing, expected_mtime, force.unwrap_or(false)) {
        if mtime_ms(meta) != expected {
            return Err(CmdError::new(
                "conflict",
                format!("{path} was modified outside LOGICA"),
            ));
        }
    }
    let file_name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = file.with_file_name(format!(".{file_name}.logica-tmp"));
    std::fs::write(&tmp, content.as_bytes())?;
    if let Some(meta) = &existing {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(err) = std::fs::rename(&tmp, &file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    let meta = std::fs::metadata(&file)?;
    Ok(WriteResult {
        mtime: mtime_ms(&meta),
    })
}

#[tauri::command]
pub async fn stat_files(root: String, paths: Vec<String>) -> CmdResult<Vec<FileStat>> {
    let root_path = canonical_root(&root)?;
    Ok(paths
        .into_iter()
        .map(|path| {
            let mtime = resolve(&root_path, &path)
                .ok()
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| mtime_ms(&m));
            FileStat { path, mtime }
        })
        .collect())
}

/// Return a binary file (the compiled PDF) as raw bytes.
#[tauri::command]
pub async fn read_binary_file(root: String, path: String) -> CmdResult<Response> {
    let root_path = canonical_root(&root)?;
    let file = resolve(&root_path, &path)?;
    let meta = std::fs::metadata(&file)?;
    if meta.len() > MAX_BINARY_BYTES {
        return Err(CmdError::new("too_large", format!("{path} is too large")));
    }
    Ok(Response::new(std::fs::read(&file)?))
}

#[tauri::command]
pub async fn path_exists(root: String, path: String) -> CmdResult<bool> {
    let root_path = canonical_root(&root)?;
    Ok(resolve(&root_path, &path).map(|p| p.exists()).unwrap_or(false))
}

const STARTER_MAIN: &str = include_str!("../templates/main.tex");

/// Create a one-page starter paper under Documents/LOGICA and return its
/// folder. With `reuse`, an existing "My Paper" with a main.tex is returned
/// as is; otherwise the next free "My Paper N" folder is created.
#[tauri::command]
pub async fn create_starter_project(app: tauri::AppHandle, reuse: bool) -> CmdResult<String> {
    use tauri::Manager;

    let paths = app.path();
    let base = paths
        .document_dir()
        .or_else(|_| paths.home_dir())
        .map_err(|e| CmdError::new("io", e.to_string()))?
        .join("LOGICA");
    let folder = starter_folder(&base, reuse);
    std::fs::create_dir_all(&folder)?;
    let main = folder.join("main.tex");
    if !main.exists() {
        std::fs::write(&main, STARTER_MAIN)?;
    }
    Ok(folder.to_string_lossy().into_owned())
}

fn starter_folder(base: &Path, reuse: bool) -> PathBuf {
    let first = base.join("My Paper");
    if (reuse && first.join("main.tex").is_file()) || !first.exists() {
        return first;
    }
    (2..).map(|n| base.join(format!("My Paper {n}"))).find(|p| !p.exists()).expect("unbounded range")
}

/// Save a copy of the compiled PDF where the user chooses. The destination
/// comes from the native save dialog shown here, never from the webview.
/// Returns the saved path, or None when the dialog was cancelled.
#[tauri::command]
pub async fn export_pdf(app: tauri::AppHandle, root: String, path: String, title: String) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let root_path = canonical_root(&root)?;
    let source = resolve(&root_path, &path)?;
    if source.extension().and_then(|e| e.to_str()) != Some("pdf") || !source.is_file() {
        return Err(CmdError::new("not_found", format!("{path} is not a compiled PDF")));
    }
    let file_name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "paper.pdf".into());
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter("PDF", &["pdf"]);
    let chosen = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))?;
    let Some(chosen) = chosen else { return Ok(None) };
    let mut dest = chosen.into_path().map_err(|e| CmdError::new("invalid_path", e.to_string()))?;
    if dest.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")) != Some(true) {
        dest.set_extension("pdf");
    }
    std::fs::copy(&source, &dest)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_refuses_to_overwrite_external_changes() {
        let dir = std::env::temp_dir().join(format!("logica-write-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let first = write_text_file(root.clone(), "a.tex".into(), "one".into(), None, None).await.unwrap();
        let second = write_text_file(root.clone(), "a.tex".into(), "two".into(), Some(first.mtime), None).await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("a.tex"), "external").unwrap();
        let err = write_text_file(root.clone(), "a.tex".into(), "three".into(), Some(second.mtime), None).await.err().unwrap();
        assert_eq!(err.kind, "conflict");
        write_text_file(root.clone(), "a.tex".into(), "three".into(), Some(second.mtime), Some(true)).await.unwrap();
        let file = read_text_file(root, "a.tex".into()).await.unwrap();
        assert_eq!(file.content, "three");
    }

    #[test]
    fn starter_folders_are_reused_or_numbered() {
        let base = std::env::temp_dir().join(format!("logica-starter-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(starter_folder(&base, true), base.join("My Paper"));
        std::fs::create_dir_all(base.join("My Paper")).unwrap();
        std::fs::write(base.join("My Paper/main.tex"), STARTER_MAIN).unwrap();
        assert_eq!(starter_folder(&base, true), base.join("My Paper"));
        assert_eq!(starter_folder(&base, false), base.join("My Paper 2"));
        std::fs::create_dir_all(base.join("My Paper 2")).unwrap();
        assert_eq!(starter_folder(&base, false), base.join("My Paper 3"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_paths_outside_root() {
        let dir = std::env::temp_dir().join("logica-resolve-test");
        std::fs::create_dir_all(dir.join("sections")).unwrap();
        let root = dir.canonicalize().unwrap();
        assert!(resolve(&root, "sections/intro.tex").is_ok());
        assert!(resolve(&root, "../etc/passwd").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        assert!(resolve(&root, "sections/../../x").is_err());
        assert!(resolve(&root, "").is_err());
    }
}
