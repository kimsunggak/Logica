/** Typed wrappers for the LaTeX compile commands of the backend. */
import { call } from "../../lib/backend";
import type { CompilerSetting } from "../../settings/settingsStore";

export interface CompileResult {
  success: boolean;
  compiler: string;
  pdfPath: string | null;
  pdfMtime: number | null;
  log: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface DetectedTool {
  name: string;
  path: string;
}

export interface CompileOptions {
  root: string;
  mainFile: string;
  compiler: CompilerSetting;
  compilerPath?: string;
  customCommand?: string;
  timeoutSecs?: number;
}

export function compileLatex(options: CompileOptions, jobId?: string): Promise<CompileResult> {
  return call<CompileResult>("compile_latex", {
    request: {
      root: options.root,
      mainFile: options.mainFile,
      compiler: options.compiler,
      compilerPath: options.compilerPath || null,
      customCommand: options.customCommand || null,
      timeoutSecs: options.timeoutSecs ?? null,
      jobId: jobId ?? null,
    },
  });
}

export function detectCompilers(): Promise<DetectedTool[]> {
  return call<DetectedTool[]>("detect_compilers");
}

/** Stop a running compilation started with this job id (its TeX process is killed). */
export async function cancelCompileJob(jobId: string): Promise<void> {
  await call<boolean>("compile_cancel", { jobId }).catch(() => false);
}
