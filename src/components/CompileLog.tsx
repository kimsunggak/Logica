import { ChevronDown, ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { navigateTo } from "../project/projectActions";
import { useProject } from "../project/projectStore";

/** Extracted compile errors and warnings; click to jump to the source line. */
export function CompileLog() {
  const compile = useProject((s) => s.compile);
  const mainFile = useProject((s) => s.mainFile);
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const errors = compile.log?.errors ?? [];
  const warnings = compile.log?.warnings ?? [];

  useEffect(() => {
    if (compile.status === "failed") setOpen(true);
    if (compile.status === "success") setOpen(false);
  }, [compile.status, compile.result]);

  if (compile.status === "idle" || compile.status === "running") return null;
  const failed = compile.status === "failed";
  const summary = compile.error
    ? "Compilation could not run"
    : failed
      ? `Compilation failed: ${errors.length} error${errors.length === 1 ? "" : "s"}`
      : `Compiled${compile.result ? ` in ${(compile.result.durationMs / 1000).toFixed(1)}s` : ""}${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}`;

  return (
    <div className="shrink-0 border-t border-slate-200 dark:border-slate-800" data-testid="compile-log">
      <button
        className={`flex h-7 w-full items-center gap-1.5 px-3 text-left text-[12px] ${
          failed ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200" : "text-slate-600 dark:text-slate-300"
        }`}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-medium">{summary}</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-auto px-3 py-1.5 text-[12px]">
          {compile.error && <div className="mb-1 text-red-700 dark:text-red-300">{compile.error}</div>}
          {[...errors, ...warnings].map((item, i) => {
            const file = item.file ?? (item.line ? mainFile : undefined);
            const clickable = Boolean(file && item.line);
            return (
              <div
                key={i}
                className={`flex gap-2 rounded px-1 py-1 ${clickable ? "cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800" : ""}`}
                onClick={() => clickable && void navigateTo(file!, item.line!)}
              >
                {item.severity === "error" ? (
                  <CircleAlert size={13} className="mt-0.5 shrink-0 text-red-600" />
                ) : (
                  <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-600" />
                )}
                <div className="min-w-0">
                  {file && item.line && (
                    <div className="font-mono text-[11.5px] text-slate-500">
                      {file}:{item.line}
                    </div>
                  )}
                  <div className="text-slate-800 dark:text-slate-200">{item.message}</div>
                  {item.context && <div className="font-mono text-[11.5px] text-slate-500">{item.context}</div>}
                  {item.hint && <div className="text-[11.5px] text-slate-500 italic">{item.hint}</div>}
                </div>
              </div>
            );
          })}
          {compile.result?.output && (
            <div className="mt-1">
              <button className="text-[11.5px] text-slate-500 underline" onClick={() => setShowRaw(!showRaw)}>
                {showRaw ? "Hide" : "Show"} raw compiler output
              </button>
              {showRaw && (
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                  {compile.result.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
