//! Local LaTeX compilation.
//!
//! The frontend chooses a compiler (`auto`, `latexmk`, `pdflatex`, `xelatex`
//! or a custom command). This module runs it inside the project folder with a
//! timeout and returns the raw `.log` so the frontend can extract the relevant
//! errors.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{CmdError, CmdResult};
use crate::project::{canonical_root, mtime_ms, resolve};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const OUTPUT_TAIL_CHARS: usize = 20_000;
const KNOWN_TOOLS: &[&str] = &["latexmk", "pdflatex", "xelatex", "lualatex", "bibtex", "biber"];

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
}

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

#[tauri::command]
pub async fn detect_compilers() -> Vec<DetectedTool> {
    let path_var = search_path();
    KNOWN_TOOLS
        .iter()
        .filter_map(|name| {
            find_tool(name, None, &path_var).ok().map(|p| DetectedTool {
                name: (*name).to_string(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect()
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

#[tauri::command]
pub async fn compile_latex(request: CompileRequest) -> CmdResult<CompileResult> {
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
    let timeout = Duration::from_secs(request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(5, 3600));
    let deadline = tokio::time::Instant::now() + timeout;
    let explicit = request.compiler_path.as_deref();

    let compiler = if request.compiler == "auto" {
        ["latexmk", "pdflatex", "xelatex"]
            .into_iter()
            .find(|name| find_tool(name, None, &path_var).is_ok())
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
                success &= out.success;
                combined_output.push_str(&out.output);
            }
            "pdflatex" | "xelatex" => {
                let engine = find_tool(&compiler, explicit, &path_var)?;
                let first = run(engine.clone(), common_args(&file_name)).await?;
                combined_output.push_str(&first.output);
                let aux = std::fs::read_to_string(cwd.join(format!("{stem}.aux"))).unwrap_or_default();
                let mut passes = 0;
                if aux.contains("\\bibdata") {
                    if let Ok(bibtex) = find_tool("bibtex", None, &path_var) {
                        let out = run(bibtex, vec![stem.clone()]).await?;
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
                    last = run(engine.clone(), common_args(&file_name)).await?;
                    combined_output.push_str(&last.output);
                }
                success &= last.success;
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
        let result = compile_latex(request(&root, "auto")).await.unwrap();
        assert!(result.success, "{}", result.output);
        assert_eq!(result.compiler, "latexmk");
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
        let result = compile_latex(request(&root, "pdflatex")).await.unwrap();
        assert!(!result.success);
        assert!(result.log.contains("sections/method.tex:"), "{}", result.log);
        assert!(result.log.contains("Undefined control sequence"));
    }

    #[tokio::test]
    async fn missing_compiler_is_a_clear_error() {
        let root = sample_project("missing");
        let mut req = request(&root, "xelatex");
        req.compiler_path = Some("/nonexistent/xelatex".into());
        let err = compile_latex(req).await.err().expect("should fail");
        assert_eq!(err.kind, "compiler_not_found");
    }
}
