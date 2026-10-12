import { Check, CornerDownLeft, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { INLINE_COMMANDS } from "../../ai/prompts";
import { PROVIDER_LABELS } from "../../ai/providers/registry";
import type { ProviderId } from "../../ai/types";
import { ProviderSelect } from "../../components/ProviderSelect";
import { useProject } from "../../project/projectStore";
import { aiTargetField } from "../aiTarget";
import { editorSession } from "../editorSession";
import { DiffView } from "./DiffView";
import {
  acceptInlineEdit,
  regenerateInlineEdit,
  rejectInlineEdit,
  runInlineEdit,
  setInlineProvider,
  stopInlineEdit,
  useInlineEdit,
} from "./inlineEditStore";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

interface Position {
  top: number;
  left: number;
  width: number;
}

function usePanelPosition(container: RefObject<HTMLDivElement | null>, panel: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [position, setPosition] = useState<Position | null>(null);
  useLayoutEffect(() => {
    const view = editorSession.getView();
    const host = container.current;
    if (!view || !host) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = view.state.field(aiTargetField, false);
        const rect = host.getBoundingClientRect();
        const width = Math.max(320, Math.min(720, rect.width - 64));
        const panelHeight = panel.current?.offsetHeight ?? 160;
        let top = 48;
        if (target) {
          const end = view.coordsAtPos(target.to, -1);
          const start = view.coordsAtPos(target.from, 1);
          const below = end ? end.bottom - rect.top + 6 : null;
          const above = start ? start.top - rect.top - panelHeight - 6 : null;
          if (below !== null && below + panelHeight < rect.height - 8) top = below;
          else if (above !== null && above > 8) top = above;
          else top = Math.max(8, rect.height - panelHeight - 8);
        }
        top = Math.max(8, Math.min(top, rect.height - Math.min(panelHeight, rect.height - 16) - 8));
        setPosition({ top, left: Math.max(8, Math.min(52, rect.width - width - 8)), width });
      });
    };
    measure();
    view.scrollDOM.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    return () => {
      cancelAnimationFrame(frame);
      view.scrollDOM.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, deps);
  return position;
}

export function InlineEditPanel({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const state = useInlineEdit();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [diffMode, setDiffMode] = useState<"words" | "lines">("words");
  const [regenProvider, setRegenProvider] = useState<ProviderId>(state.provider);
  const position = usePanelPosition(container, panelRef, [state.open, state.phase, state.path]);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (state.open && state.phase === "input") {
      setDraft(state.instruction);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // Keep focus in the panel so Esc / Cmd+Enter work in every phase.
    if (state.open && state.phase !== "input") requestAnimationFrame(() => panelRef.current?.focus());
  }, [state.open, state.phase, state.instruction]);

  useEffect(() => setRegenProvider(state.provider), [state.provider]);

  // The edit belongs to one file: switching files discards it.
  const activePath = useProject((s) => s.activePath);
  useEffect(() => {
    const { open, path } = useInlineEdit.getState();
    if (open && path && activePath !== path) rejectInlineEdit();
  }, [activePath]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [state.output]);

  if (!state.open) return null;

  const submit = (instruction: string) => {
    if (instruction.trim()) void runInlineEdit(instruction.trim());
  };
  const errors = state.issues.filter((i) => i.severity === "error");
  const warnings = state.issues.filter((i) => i.severity === "warning");

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="inline-edit-panel"
      className="absolute z-30 flex max-h-[70%] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl outline-none dark:border-slate-700 dark:bg-[#151c26]"
      style={{ top: position?.top ?? 48, left: position?.left ?? 52, width: position?.width ?? 560, visibility: position ? "visible" : "hidden" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (state.phase === "streaming") stopInlineEdit();
          else rejectInlineEdit();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && state.phase === "review") {
          e.preventDefault();
          acceptInlineEdit();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
        <Sparkles size={14} className="text-sky-600 dark:text-sky-400" />
        <span className="text-[12px] font-semibold tracking-wide">LOGICA</span>
        {state.phase === "input" || state.phase === "error" ? (
          <ProviderSelect value={state.provider} onChange={setInlineProvider} className="h-6 text-[12px]" />
        ) : (
          <span className="text-[12px] text-slate-500 dark:text-slate-400">{PROVIDER_LABELS[state.provider]}</span>
        )}
        <span className="truncate text-[11.5px] text-slate-400" title={state.model}>
          {state.model}
        </span>
        <button className="icon-btn ml-auto" title="Close (Esc)" onClick={rejectInlineEdit}>
          <X size={14} />
        </button>
      </div>

      {state.phase === "input" && (
        <div className="p-3">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">›</span>
            <input
              ref={inputRef}
              data-testid="inline-edit-input"
              className="input h-8 flex-1"
              placeholder="Ask LOGICA to edit the selection… e.g. Make this more concise"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Ignore Enter that only confirms an IME composition (Korean, Japanese, ...).
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit(draft);
                }
              }}
            />
            <button className="btn-primary h-8" disabled={!draft.trim()} title="Run (Enter)" onClick={() => submit(draft)}>
              <CornerDownLeft size={13} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {INLINE_COMMANDS.map((cmd) => (
              <button key={cmd.id} className="btn h-6 px-2 text-[11.5px]" onClick={() => submit(cmd.instruction)} title={cmd.instruction}>
                {cmd.label}
              </button>
            ))}
          </div>
          {state.note && <div className="mt-2 text-[11.5px] text-slate-500">{state.note}</div>}
        </div>
      )}

      {state.phase === "streaming" && (
        <div className="flex min-h-0 flex-col gap-2 p-3">
          <div className="flex items-center gap-2 text-[12px] text-slate-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
            Writing with {PROVIDER_LABELS[state.provider]}…
            <button className="btn ml-auto h-6" onClick={stopInlineEdit} data-testid="inline-edit-stop">
              <Square size={11} /> Stop
            </button>
          </div>
          <pre
            ref={outputRef}
            className="max-h-64 min-h-10 overflow-auto rounded-md bg-slate-50 p-2 font-mono text-[12px] whitespace-pre-wrap text-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            {state.output || " "}
          </pre>
        </div>
      )}

      {state.phase === "review" && (
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 px-3 pt-2 text-[11.5px] text-slate-500">
            <span>{state.origin === "chat" ? "Suggested in chat" : "Review the change"}</span>
            <div className="ml-auto flex overflow-hidden rounded border border-slate-200 dark:border-slate-700">
              {(["words", "lines"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`px-2 py-0.5 ${diffMode === mode ? "bg-slate-100 font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-100" : ""}`}
                  onClick={() => setDiffMode(mode)}
                >
                  {mode === "words" ? "Words" : "Lines"}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 overflow-auto px-3 py-2" data-testid="inline-edit-diff">
            {state.result === state.original ? (
              <div className="text-[12px] text-slate-500">The AI suggested no changes for this text.</div>
            ) : (
              <DiffView original={state.original} revised={state.result} mode={diffMode} />
            )}
          </div>
          {(errors.length > 0 || warnings.length > 0) && (
            <ul className="mx-3 mb-2 space-y-0.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11.5px] dark:bg-amber-950/40" data-testid="inline-edit-issues">
              {errors.map((issue, i) => (
                <li key={`e${i}`} className="text-red-700 dark:text-red-300">
                  ✕ {issue.message}
                </li>
              ))}
              {warnings.map((issue, i) => (
                <li key={`w${i}`} className="text-amber-800 dark:text-amber-300">
                  ⚠ {issue.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
            <button
              className={errors.length ? "btn-danger" : "btn-primary"}
              onClick={acceptInlineEdit}
              data-testid="inline-edit-accept"
              title={`Apply the change (${MOD}+Enter)`}
            >
              <Check size={13} /> {errors.length ? "Accept anyway" : "Accept"}
              <span className="ml-1 opacity-70">{MOD}↵</span>
            </button>
            <button className="btn" onClick={rejectInlineEdit} data-testid="inline-edit-reject" title="Discard (Esc)">
              <X size={13} /> Reject
            </button>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[11.5px] text-slate-500">Regenerate with</span>
              <ProviderSelect value={regenProvider} onChange={setRegenProvider} className="h-7" />
              <button className="btn" onClick={() => regenerateInlineEdit(regenProvider)} data-testid="inline-edit-regenerate">
                <RotateCcw size={13} /> Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {state.phase === "error" && (
        <div className="space-y-2 p-3" data-testid="inline-edit-error">
          <div className="rounded-md bg-red-50 px-2 py-1.5 text-[12px] text-red-800 dark:bg-red-950/50 dark:text-red-200">{state.error}</div>
          <div className="flex gap-2">
            {state.instruction && (
              <button className="btn-primary" onClick={() => regenerateInlineEdit(state.provider)}>
                <RotateCcw size={13} /> Retry with {PROVIDER_LABELS[state.provider]}
              </button>
            )}
            <button className="btn" onClick={() => useInlineEdit.setState({ phase: "input", error: undefined })}>
              Edit instruction
            </button>
            <button className="btn" onClick={rejectInlineEdit}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
