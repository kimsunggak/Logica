/**
 * Debug view of the chat pipeline for the latest question:
 *
 *   👤 User → 🧭 Intent Module → 🤖 Answer Agent → 💬 Answer
 *
 * The running step is highlighted; clicking a step shows what it received,
 * what it produced and what it passed on.
 */
import { useEffect, useState } from "react";
import { useT, type MessageKey } from "../i18n";
import { useChat } from "./chatStore";
import { STEPS, type StepId, type StepStatus, type StepTrace, type TraceField } from "./pipeline";

const STEP_LABEL: Record<StepId, { icon: string; label: MessageKey }> = {
  user: { icon: "👤", label: "debug.user" },
  intent: { icon: "🧭", label: "debug.intentModule" },
  agent: { icon: "🤖", label: "debug.answerAgent" },
  answer: { icon: "💬", label: "debug.answerStep" },
};

const STATUS_CLASS: Record<StepStatus, string> = {
  waiting: "border-slate-200 text-slate-400 dark:border-slate-700",
  running: "animate-pulse border-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-950/60 dark:text-sky-100",
  done: "border-emerald-500 text-slate-800 dark:text-slate-100",
  error: "border-red-500 bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-100",
};

/** Characters of a long value shown before "show all". */
const PREVIEW = 400;

function Field({ field }: { field: TraceField }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const long = field.value.length > PREVIEW;
  return (
    <div className="space-y-0.5">
      <div className="text-[10.5px] font-medium text-slate-500">{t(field.label)}</div>
      <pre className="max-h-48 overflow-auto rounded border border-slate-200 bg-white p-1.5 font-mono text-[11px] whitespace-pre-wrap break-words dark:border-slate-700 dark:bg-slate-900">
        {long && !all ? `${field.value.slice(0, PREVIEW)}…` : field.value}
      </pre>
      {long && !all && (
        <button className="text-[10.5px] text-sky-700 hover:underline dark:text-sky-300" onClick={() => setAll(true)}>
          {t("debug.showAll", { count: field.value.length.toLocaleString() })}
        </button>
      )}
    </div>
  );
}

function Group({ title, fields, empty }: { title: MessageKey; fields: TraceField[]; empty: string }) {
  const t = useT();
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">{t(title)}</div>
      {fields.length ? fields.map((f, i) => <Field key={`${f.label}-${i}`} field={f} />) : <div className="text-[11px] text-slate-400">{empty}</div>}
    </div>
  );
}

export function PipelineDebug() {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const traces = useChat((s) => s.traces);
  const latest = [...messages].reverse().find((m) => m.role === "assistant" && traces[m.id]);
  const trace = latest ? traces[latest.id] : undefined;
  const [picked, setPicked] = useState<StepId | null>(null);

  // A new question starts with the step that is running.
  useEffect(() => setPicked(null), [latest?.id]);

  if (!trace || !latest) {
    return (
      <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] text-slate-500 dark:border-slate-800 dark:bg-[#121820]" data-testid="pipeline-debug">
        {t("debug.empty")}
      </div>
    );
  }

  const active = STEPS.find((id) => trace[id].status === "running" || trace[id].status === "error");
  const lastReached = [...STEPS].reverse().find((id) => trace[id].status !== "waiting") ?? "user";
  const selected = picked ?? active ?? lastReached;
  const step: StepTrace = trace[selected];
  // The Answer Agent's reply streams into the message while it runs.
  const output =
    selected === "agent" && step.status === "running" && latest.content
      ? [{ label: "debug.reply" as const, value: latest.content }]
      : step.output;

  return (
    <div className="max-h-[55%] shrink-0 space-y-2 overflow-y-auto border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-[#121820]" data-testid="pipeline-debug">
      <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{t("debug.title")}</div>
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch gap-1" role="list">
        {STEPS.map((id, i) => {
          const s = trace[id];
          return [
            i > 0 && (
              <span
                key={`${id}-arrow`}
                className={`self-center text-[12px] ${trace[STEPS[i - 1]].status === "done" ? "text-emerald-600" : "text-slate-300"}`}
                aria-hidden
              >
                →
              </span>
            ),
            <button
              key={id}
              role="listitem"
              className={`flex min-w-0 flex-col items-center gap-0.5 rounded-md border-2 px-1 py-1 text-center text-[11px] ${STATUS_CLASS[s.status]} ${
                selected === id ? "ring-2 ring-slate-400 ring-offset-1 dark:ring-slate-500 dark:ring-offset-slate-900" : ""
              }`}
              onClick={() => setPicked(id)}
              aria-pressed={selected === id}
              data-testid={`pipeline-step-${id}`}
              data-status={s.status}
            >
              <span className="text-[15px] leading-none">{STEP_LABEL[id].icon}</span>
              <span className="font-medium leading-tight">{t(STEP_LABEL[id].label)}</span>
              <span className="text-[10px] leading-tight opacity-75">
                {t(`debug.${s.status}`)}
                {s.ms !== undefined ? ` ${t("debug.ms", { ms: s.ms.toLocaleString() })}` : ""}
              </span>
            </button>,
          ];
        })}
      </div>
      <div className="space-y-2 rounded-md border border-slate-200 bg-white/60 p-2 dark:border-slate-700 dark:bg-slate-900/40" data-testid="pipeline-detail">
        <Group title="debug.input" fields={step.input} empty={t("debug.none")} />
        <Group title="debug.output" fields={output} empty={t("debug.none")} />
        <Group title="debug.next" fields={step.next} empty={selected === "answer" ? t("debug.final") : t("debug.none")} />
      </div>
    </div>
  );
}
