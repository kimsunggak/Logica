//! Local LaTeX compilation.
//!
//! The frontend chooses a compiler (`auto`, `latexmk`, `pdflatex`, `xelatex`
//! or a custom command). This module runs it inside the project folder with a
//! timeout and returns the raw `.log` so the frontend can extract the relevant
//! errors.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{CmdError, CmdResult};
use crate::project::{canonical_root, mtime_ms, resolve};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const OUTPUT_TAIL_CHARS: usize = 20_000;
const KNOWN_TOOLS: &[&str] = &["latexmk", "pdflatex", "xelatex", "lualatex", "bibtex", "biber"];
/// The bundled engine may download support files on its first runs.
const TECTONIC_MIN_TIMEOUT_SECS: u64 = 600;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileRequest {
    root: String,
    /// Project-relative path of the root document, e.g. `main.tex`.
    main_file: String,
    /// `auto` | `latexmk` | `pdflatex` | `xelatex` | `custom`
    compiler: String,
    /// Optional explicit path to the compiler binary.
    compiler_path: Option<String>,
    /// Used when `compiler` is `custom`. `{main}` and `{name}` are substituted.
    custom_command: Option<String>,
    timeout_secs: Option<u64>,
    /// Lets the frontend cancel this run with `compile_cancel` (e.g. when the
    /// author leaves the project); the TeX process is then killed.
    job_id: Option<String>,
}

/// Compilations that can still be cancelled, by job id.
#[derive(Default)]
pub struct CompileJobs(Mutex<HashMap<String, Arc<Notify>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    success: bool,
    compiler: String,
    /// Project-relative path of the produced PDF, if one was (re)generated.
    pdf_path: Option<String>,
    pdf_mtime: Option<u64>,
    /// Contents of the LaTeX `.log` file.
    log: String,
    /// Tail of the combined stdout/stderr of the toolchain.
    output: String,
    duration_ms: u64,
    timed_out: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTool {
    name: String,
    path: String,
}

/// GUI apps (notably on macOS) do not inherit the login shell PATH, so the
/// usual TeX installation folders are added explicitly.
fn search_path() -> OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        for extra in [
            "/Library/TeX/texbin",
            "/usr/texbin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
        ] {
            dirs.push(PathBuf::from(extra));
        }
        for base in ["/usr/local/texlive", "/opt/texlive"] {
            if let Ok(years) = std::fs::read_dir(base) {
                let mut years: Vec<_> = years.flatten().map(|e| e.path()).collect();
                years.sort();
                years.reverse();
                for year in years {
                    if let Ok(arches) = std::fs::read_dir(year.join("bin")) {
                        dirs.extend(arches.flatten().map(|e| e.path()));
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs\\MiKTeX\\miktex\\bin\\x64"));
        }
        dirs.push(PathBuf::from("C:\\Program Files\\MiKTeX\\miktex\\bin\\x64"));
        if let Ok(years) = std::fs::read_dir("C:\\texlive") {
            for year in years.flatten() {
                dirs.push(year.path().join("bin\\windows"));
                dirs.push(year.path().join("bin\\win64"));
            }
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn find_tool(name: &str, explicit: Option<&str>, path_var: &OsString) -> CmdResult<PathBuf> {
    if let Some(explicit) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(CmdError::new(
            "compiler_not_found",
            format!("Configured compiler path does not exist: {explicit}"),
        ));
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    which::which_in(name, Some(path_var), cwd).map_err(|_| {
        CmdError::new(
            "compiler_not_found",
            format!("{name} was not found. Install a TeX distribution (TeX Live, MacTeX or MiKTeX) or set the compiler path in Settings."),
        )
    })
}

/// Tectonic, shipped with LOGICA as a Tauri sidecar next to the executable.
/// `LOGICA_TECTONIC` points elsewhere (development and tests).
fn bundled_tectonic() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("LOGICA_TECTONIC").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join(format!("tectonic{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

/// Automatic choice: a TeX distribution installed on the computer first (best
/// package coverage), then the engine bundled with LOGICA.
fn pick_auto(installed: impl Fn(&str) -> bool, bundled: bool) -> Option<&'static str> {
    ["latexmk", "pdflatex", "xelatex"]
        .into_iter()
        .find(|name| installed(name))
        .or(bundled.then_some("tectonic"))
}

#[tauri::command]
pub async fn detect_compilers() -> Vec<DetectedTool> {
    let path_var = search_path();
    let mut tools: Vec<DetectedTool> = KNOWN_TOOLS
        .iter()
        .filter_map(|name| {
            find_tool(name, None, &path_var).ok().map(|p| DetectedTool {
                name: (*name).to_string(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect();
    if let Some(path) = bundled_tectonic() {
        tools.push(DetectedTool {
            name: "tectonic".into(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    tools
}

struct StepOutput {
    success: bool,
    output: String,
}

enum StepError {
    TimedOut,
    Cmd(CmdError),
}

impl From<CmdError> for StepError {
    fn from(err: CmdError) -> Self {
        StepError::Cmd(err)
    }
}

fn spawn_error(program: &Path, err: std::io::Error) -> StepError {
    let kind = if err.kind() == std::io::ErrorKind::NotFound {
        "compiler_not_found"
    } else {
        "compile_failed"
    };
    StepError::Cmd(CmdError::new(kind, format!("Could not run {}: {err}", program.display())))
}

async fn run_step(
    program: &Path,
    args: &[String],
    cwd: &Path,
    path_var: &OsString,
    deadline: tokio::time::Instant,
) -> Result<StepOutput, StepError> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", path_var)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| spawn_error(program, e))?;
    match tokio::time::timeout_at(deadline, child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
            output.push_str(&String::from_utf8_lossy(&out.stderr));
            Ok(StepOutput {
                success: out.status.success(),
                output,
            })
        }
        Ok(Err(err)) => Err(spawn_error(program, err)),
        // Dropping the future drops the child, which kills it (kill_on_drop).
        Err(_) => Err(StepError::TimedOut),
    }
}

fn tail(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().skip(count - max_chars).collect()
}

fn shell_command(command: &str) -> (PathBuf, Vec<String>) {
    #[cfg(windows)]
    {
        (PathBuf::from("cmd"), vec!["/C".into(), command.into()])
    }
    #[cfg(not(windows))]
    {
        (PathBuf::from("sh"), vec!["-c".into(), command.into()])
    }
}

fn common_args(file_name: &str) -> Vec<String> {
    vec![
        "-interaction=nonstopmode".into(),
        "-file-line-error".into(),
        "-synctex=1".into(),
        file_name.into(),
    ]
}

/// latexmk failed before LaTeX ran because its Perl interpreter is missing
/// (MiKTeX: "could not find the script engine 'perl'").
fn latexmk_unusable(output: &str) -> bool {
    let o = output.to_lowercase();
    o.contains("script engine") || (o.contains("perl") && (o.contains("not found") || o.contains("could not find") || o.contains("not recognized")))
}

/// Run a LaTeX engine directly, with BibTeX and extra passes when needed so
/// that the bibliography and cross references resolve without latexmk.
async fn engine_passes(
    engine: &Path,
    file_name: &str,
    stem: &str,
    cwd: &Path,
    path_var: &OsString,
    deadline: tokio::time::Instant,
    combined_output: &mut String,
) -> Result<bool, StepError> {
    let first = run_step(engine, &common_args(file_name), cwd, path_var, deadline).await?;
    combined_output.push_str(&first.output);
    let aux = std::fs::read_to_string(cwd.join(format!("{stem}.aux"))).unwrap_or_default();
    let mut passes = 0;
    if aux.contains("\\bibdata") {
        if let Ok(bibtex) = find_tool("bibtex", None, path_var) {
            let out = run_step(&bibtex, &[stem.to_string()], cwd, path_var, deadline).await?;
            combined_output.push_str(&out.output);
            passes = 2;
        }
    }
    let log = std::fs::read_to_string(cwd.join(format!("{stem}.log"))).unwrap_or_default();
    if passes == 0 && log.contains("Rerun to get") {
        passes = 1;
    }
    let mut last = first;
    for _ in 0..passes {
        last = run_step(engine, &common_args(file_name), cwd, path_var, deadline).await?;
        combined_output.push_str(&last.output);
    }
    Ok(last.success)
}

#[tauri::command]
pub async fn compile_latex(jobs: State<'_, CompileJobs>, request: CompileRequest) -> CmdResult<CompileResult> {
    let Some(id) = request.job_id.clone() else {
        return compile(request).await;
    };
    let cancel = Arc::new(Notify::new());
    jobs.0
        .lock()
        .map_err(|_| CmdError::new("internal", "compile registry poisoned"))?
        .insert(id.clone(), cancel.clone());
    let result = compile_until_cancelled(request, cancel).await;
    if let Ok(mut map) = jobs.0.lock() {
        map.remove(&id);
    }
    result
}

/// Stop a running compilation. Returns whether a job with that id was running.
#[tauri::command]
pub async fn compile_cancel(jobs: State<'_, CompileJobs>, job_id: String) -> CmdResult<bool> {
    let map = jobs.0.lock().map_err(|_| CmdError::new("internal", "compile registry poisoned"))?;
    Ok(map.get(&job_id).map(|cancel| cancel.notify_one()).is_some())
}

/// Dropping the compile future drops the running child process, which
/// `kill_on_drop` terminates.
async fn compile_until_cancelled(request: CompileRequest, cancel: Arc<Notify>) -> CmdResult<CompileResult> {
    tokio::select! {
        result = compile(request) => result,
        _ = cancel.notified() => Err(CmdError::new("cancelled", "Compilation cancelled")),
    }
}

async fn compile(request: CompileRequest) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let started_wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let root = canonical_root(&request.root)?;
    let main = resolve(&root, &request.main_file)?;
    if !main.is_file() {
        return Err(CmdError::new(
            "main_not_found",
            format!("Main file not found: {}", request.main_file),
        ));
    }
    let cwd = main.parent().unwrap_or(&root).to_path_buf();
    let file_name = main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = main
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path_var = search_path();
    let explicit = request.compiler_path.as_deref();

    let auto = request.compiler == "auto";
    let mut compiler = if auto {
        pick_auto(|name| find_tool(name, None, &path_var).is_ok(), bundled_tectonic().is_some())
            .ok_or_else(|| {
                CmdError::new(
                    "compiler_not_found",
                    "No LaTeX compiler found (latexmk, pdflatex or xelatex). Install TeX Live, MacTeX or MiKTeX, or set the compiler path in Settings.",
                )
            })?
            .to_string()
    } else {
        request.compiler.clone()
    };
    let mut timeout_secs = request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(5, 3600);
    if compiler == "tectonic" {
        timeout_secs = timeout_secs.max(TECTONIC_MIN_TIMEOUT_SECS);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    // Each step is (program, args). Engines run several passes so that
    // bibliography and cross references resolve without latexmk.
    let mut combined_output = String::new();
    let mut success = true;
    let mut timed_out = false;

    let run = |program: PathBuf, args: Vec<String>| {
        let cwd = cwd.clone();
        let path_var = path_var.clone();
        async move { run_step(&program, &args, &cwd, &path_var, deadline).await }
    };

    let outcome: Result<(), StepError> = async {
        match compiler.as_str() {
            "latexmk" => {
                let bin = find_tool("latexmk", explicit, &path_var)?;
                let mut args = vec!["-pdf".to_string()];
                args.extend(common_args(&file_name));
                let out = run(bin, args).await?;
                combined_output.push_str(&out.output);
                // MiKTeX ships latexmk as a Perl script and Windows has no Perl by default.
                // In auto mode fall back to running pdflatex directly.
                let pdflatex = find_tool("pdflatex", None, &path_var);
                if !out.success && auto && latexmk_unusable(&out.output) && pdflatex.is_ok() {
                    combined_output.push_str("\nLOGICA: latexmk could not run (Perl is missing), using pdflatex instead.\n");
                    compiler = "pdflatex".into();
                    let engine = pdflatex?;
                    success &= engine_passes(&engine, &file_name, &stem, &cwd, &path_var, deadline, &mut combined_output).await?;
                } else {
                    success &= out.success;
                }
            }
            "tectonic" => {
                let bin = match explicit.map(str::trim).filter(|s| !s.is_empty()) {
                    Some(_) => find_tool("tectonic", explicit, &path_var)?,
                    None => bundled_tectonic().ok_or_else(|| {
                        CmdError::new("compiler_not_found", "The TeX engine bundled with LOGICA is missing. Reinstall LOGICA.")
                    })?,
                };
                // Tectonic reruns TeX and runs BibTeX by itself; keep the .log for the error list.
                let args = vec![
                    "-X".to_string(),
                    "compile".into(),
                    file_name.clone(),
                    "--keep-logs".into(),
                    "--synctex".into(),
                ];
                let out = run(bin, args).await?;
                success &= out.success;
                combined_output.push_str(&out.output);
            }
            "pdflatex" | "xelatex" => {
                let engine = find_tool(&compiler, explicit, &path_var)?;
                success &= engine_passes(&engine, &file_name, &stem, &cwd, &path_var, deadline, &mut combined_output).await?;
            }
            "custom" => {
                let template = request
                    .custom_command
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| CmdError::new("compile_failed", "Custom compile command is empty"))?;
                let command = template.replace("{main}", &file_name).replace("{name}", &stem);
                let (program, args) = shell_command(&command);
                let out = run(program, args).await?;
                success &= out.success;
                combined_output.push_str(&out.output);
            }
            other => {
                return Err(CmdError::new("compile_failed", format!("Unknown compiler: {other}")).into());
            }
        }
        Ok(())
    }
    .await;

    match outcome {
        Ok(()) => {}
        Err(StepError::TimedOut) => {
            timed_out = true;
            success = false;
        }
        Err(StepError::Cmd(err)) => return Err(err),
    }

    let pdf = cwd.join(format!("{stem}.pdf"));
    let (pdf_path, pdf_mtime) = match std::fs::metadata(&pdf) {
        // Only report a PDF that this run produced or refreshed.
        Ok(meta) if mtime_ms(&meta) + 2000 >= started_wall => {
            let rel = pdf
                .strip_prefix(&root)
                .ok()
                .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            (rel, Some(mtime_ms(&meta)))
        }
        _ => (None, None),
    };
    let log = std::fs::read(cwd.join(format!("{stem}.log")))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();

    Ok(CompileResult {
        success: success && pdf_path.is_some(),
        compiler,
        pdf_path,
        pdf_mtime,
        log,
        output: tail(&combined_output, OUTPUT_TAIL_CHARS),
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_stops_the_running_compiler() {
        let root = std::env::temp_dir().join(format!("logica-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.tex"), "\\documentclass{article}").unwrap();
        let marker = root.join("finished");
        let mut req = request(&root, "custom");
        req.custom_command = Some(format!("sleep 5 && touch '{}'", marker.display()));
        let cancel = Arc::new(Notify::new());
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.notify_one();
        });
        let started = Instant::now();
        let err = compile_until_cancelled(req, cancel).await.err().expect("cancelled");
        assert_eq!(err.kind, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
        // The shell was killed, so the command after `sleep` never runs.
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert!(!marker.exists());
    }

    #[test]
    fn prefers_installed_tex_over_the_bundled_engine() {
        assert_eq!(pick_auto(|n| n == "pdflatex", true), Some("pdflatex"));
        assert_eq!(pick_auto(|n| n == "latexmk" || n == "xelatex", true), Some("latexmk"));
        assert_eq!(pick_auto(|_| false, true), Some("tectonic"));
        assert_eq!(pick_auto(|_| false, false), None);
    }

    #[test]
    fn detects_latexmk_without_perl() {
        assert!(latexmk_unusable(
            "Sorry, but latexmk did not succeed for the following reason:\n  MiKTeX could not find the script engine 'perl' which is required to execute 'latexmk'."
        ));
        assert!(latexmk_unusable("'perl' is not recognized as an internal or external command"));
        assert!(!latexmk_unusable("Latexmk: Errors, so I did not complete making targets\n! Undefined control sequence."));
    }

    fn sample_project(name: &str) -> PathBuf {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/sample-paper");
        let dst = std::env::temp_dir().join(format!("logica-compile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);
        std::fs::create_dir_all(dst.join("sections")).unwrap();
        for file in ["main.tex", "references.bib", "sections/introduction.tex", "sections/related_work.tex", "sections/method.tex", "sections/experiments.tex"] {
            std::fs::copy(src.join(file), dst.join(file)).unwrap();
        }
        dst
    }

    fn request(root: &Path, compiler: &str) -> CompileRequest {
        CompileRequest {
            root: root.to_string_lossy().into_owned(),
            main_file: "main.tex".into(),
            compiler: compiler.into(),
            compiler_path: None,
            custom_command: None,
            timeout_secs: Some(120),
            job_id: None,
        }
    }

    fn have(tool: &str) -> bool {
        find_tool(tool, None, &search_path()).is_ok()
    }

    #[tokio::test]
    async fn compiles_the_sample_paper() {
        if !have("latexmk") {
            eprintln!("latexmk not installed; skipping");
            return;
        }
        let root = sample_project("ok");
        let result = compile(request(&root, "auto")).await.unwrap();
        assert!(result.success, "{}", result.output);
        assert_eq!(result.compiler, "latexmk");
        assert_eq!(result.pdf_path.as_deref(), Some("main.pdf"));
        assert!(!result.log.is_empty());
    }

    /// Changes PATH for the whole process, so it runs alone:
    /// `cargo test falls_back -- --ignored --test-threads=1`
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn falls_back_to_pdflatex_when_latexmk_has_no_perl() {
        use std::os::unix::fs::PermissionsExt;
        if !have("pdflatex") {
            eprintln!("pdflatex not installed; skipping");
            return;
        }
        let bin = std::env::temp_dir().join(format!("logica-fake-latexmk-{}", std::process::id()));
        std::fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("latexmk");
        std::fs::write(&fake, "#!/bin/sh\necho \"MiKTeX could not find the script engine 'perl' which is required to execute 'latexmk'.\" >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs = vec![bin.clone()];
        dirs.extend(std::env::split_paths(&old));
        std::env::set_var("PATH", std::env::join_paths(dirs).unwrap());
        let root = sample_project("noperl");
        let result = compile(request(&root, "auto")).await;
        std::env::set_var("PATH", old);
        let result = result.unwrap();
        assert!(result.success, "{}", result.output);
        assert_eq!(result.compiler, "pdflatex");
        assert!(result.output.contains("using pdflatex instead"));
    }

    /// Uses a stand-in for the bundled engine (the real one downloads its
    /// support files from the internet). Changes the process environment, so
    /// it runs alone: `cargo test bundled_engine -- --ignored --test-threads=1`
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn bundled_engine_is_called_like_tectonic() {
        use std::os::unix::fs::PermissionsExt;
        if !have("pdflatex") {
            eprintln!("pdflatex not installed; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("logica-fake-tectonic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("tectonic");
        // Accept exactly the command line LOGICA uses, then build the PDF like Tectonic would.
        std::fs::write(
            &fake,
            "#!/bin/sh\n[ \"$1 $2 $4 $5\" = \"-X compile --keep-logs --synctex\" ] || { echo \"bad args: $*\" >&2; exit 2; }\nexport PATH=/usr/bin:/bin\npdflatex -interaction=nonstopmode -synctex=1 \"$3\" >/dev/null && pdflatex -interaction=nonstopmode -synctex=1 \"$3\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("LOGICA_TECTONIC", &fake);
        let root = sample_project("tectonic");
        let tools = detect_compilers().await;
        let result = compile(request(&root, "tectonic")).await;
        std::env::remove_var("LOGICA_TECTONIC");
        assert!(tools.iter().any(|t| t.name == "tectonic"));
        let result = result.unwrap();
        assert!(result.success, "{}", result.output);
        assert_eq!(result.compiler, "tectonic");
        assert_eq!(result.pdf_path.as_deref(), Some("main.pdf"));
        assert!(!result.log.is_empty());
    }

    #[tokio::test]
    async fn reports_errors_with_file_and_line() {
        if !have("pdflatex") {
            eprintln!("pdflatex not installed; skipping");
            return;
        }
        let root = sample_project("err");
        let method = root.join("sections/method.tex");
        let text = std::fs::read_to_string(&method).unwrap();
        std::fs::write(&method, text.replace("Overview}", "Overview}\\undefinedcommand")).unwrap();
        let result = compile(request(&root, "pdflatex")).await.unwrap();
        assert!(!result.success);
        assert!(result.log.contains("sections/method.tex:"), "{}", result.log);
        assert!(result.log.contains("Undefined control sequence"));
    }

    #[tokio::test]
    async fn missing_compiler_is_a_clear_error() {
        let root = sample_project("missing");
        let mut req = request(&root, "xelatex");
        req.compiler_path = Some("/nonexistent/xelatex".into());
        let err = compile(req).await.err().expect("should fail");
        assert_eq!(err.kind, "compiler_not_found");
    }
}
