import { Check, CheckCheck, FileText, GitCompare, Send, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { lineOf, locateEdit, parseEditBody, type ProposedEdit } from "../ai/agent/edits";
import { PROVIDER_LABELS } from "../ai/providers/registry";
import { ProviderSelect } from "../components/ProviderSelect";
import { DiffView } from "../editor/inlineEdit/DiffView";
import { reviewProposal } from "../editor/inlineEdit/inlineEditStore";
import { validateRewrite } from "../latex/validation";
import { currentTexts, navigateTo } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { useT, type MessageKey } from "../i18n";
import { useSettings } from "../settings/settingsStore";
import { CollapseButton } from "../components/panes";
import {
  applyAllChatEdits,
  applyChatEdit,
  chatProvider,
  clearChat,
  rejectAllChatEdits,
  rejectChatEdit,
  sendChatMessage,
  setChatProvider,
  splitBlocks,
  stopChat,
  useChat,
  type ChatMessage,
  type EditState,
} from "./chatStore";

const EXAMPLES: MessageKey[] = ["chat.example1", "chat.example2", "chat.example3", "chat.example4"];

/** One proposed change: file, location, diff, checks, and Apply / Reject. */
function EditCard({ messageId, index, edit, state }: { messageId: string; index: number; edit: ProposedEdit; state?: EditState }) {
  const t = useT();
  const bibEntries = useProject((s) => s.bibEntries);
  const issues = useMemo(
    () => validateRewrite(edit.original, edit.revised, { bibKeys: new Set(bibEntries.map((e) => e.key)) }),
    [edit, bibEntries],
  );
  const text = currentTexts().get(edit.path);
  const at = state ? null : text === undefined ? null : locateEdit(text, edit.original);
  const line = at && text !== undefined ? lineOf(text, at.from) : null;
  const errors = issues.filter((i) => i.severity === "error");
  return (
    <div
      className={`overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 ${state === "rejected" ? "opacity-50" : ""}`}
      data-testid="agent-edit"
      data-state={state ?? "pending"}
    >
      <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-2 py-1 text-[11.5px] dark:border-slate-700 dark:bg-slate-800/60">
        <FileText size={12} className="shrink-0 text-slate-400" />
        <button
          className="truncate font-mono text-slate-600 hover:underline disabled:no-underline dark:text-slate-300"
          disabled={!line}
          onClick={() => line && void navigateTo(edit.path, line)}
          title={edit.path}
        >
          {edit.path}
        </button>
        {!state && <span className={line ? "text-slate-400" : "text-amber-600"}>{line ? t("agent.line", { line }) : t("agent.lineMissing")}</span>}
        {state && (
          <span
            className={`ml-auto shrink-0 font-medium ${state === "applied" ? "text-emerald-600" : state === "failed" ? "text-red-600" : "text-slate-500"}`}
            data-testid="agent-edit-state"
          >
            {t(state === "applied" ? "agent.applied" : state === "rejected" ? "agent.rejected" : "agent.failed")}
          </span>
        )}
      </div>
      {state !== "rejected" && (
        <div className="max-h-60 overflow-auto px-2 py-1.5 text-[12px]">
          <DiffView original={edit.original} revised={edit.revised} mode="words" />
        </div>
      )}
      {!state && issues.length > 0 && (
        <ul className="mx-2 mb-1.5 space-y-0.5 rounded bg-amber-50 px-2 py-1 text-[11px] dark:bg-amber-950/40">
          {issues.map((issue, i) => (
            <li key={i} className={issue.severity === "error" ? "text-red-700 dark:text-red-300" : "text-amber-800 dark:text-amber-300"}>
              {issue.severity === "error" ? "✕" : "⚠"} {issue.message}
            </li>
          ))}
        </ul>
      )}
      {!state && (
        <div className="flex items-center gap-1.5 border-t border-slate-200 px-2 py-1 dark:border-slate-700">
          <button
            className={`${errors.length ? "btn-danger" : "btn-primary"} h-6 text-[11.5px]`}
            onClick={() => void applyChatEdit(messageId, index, edit)}
            data-testid="agent-apply"
          >
            <Check size={12} /> {t("agent.apply")}
          </button>
          <button className="btn h-6 text-[11.5px]" onClick={() => rejectChatEdit(messageId, index)} data-testid="agent-reject">
            <X size={12} /> {t("agent.reject")}
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const t = useT();
  if (message.status === "error") {
    return <div className="rounded-md bg-red-50 px-2.5 py-2 text-[12.5px] text-red-800 dark:bg-red-950/50 dark:text-red-200">{message.content}</div>;
  }
  const blocks = splitBlocks(message.content);
  const done = message.status === "done";
  // Edit blocks become reviewable cards once the answer is complete.
  const edits = new Map<number, { index: number; edit: ProposedEdit }>();
  if (done) {
    blocks.forEach((block, i) => {
      const edit = block.kind === "code" && block.lang === "edit" ? parseEditBody(block.meta ?? "", block.text) : null;
      if (edit) edits.set(i, { index: edits.size, edit });
    });
  }
  const pending = [...edits.values()].filter(({ index }) => !message.editStates?.[index]);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed">
      {edits.size > 1 && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-slate-500" data-testid="agent-edits-bar">
          <span>{t("agent.edits", { count: edits.size })}</span>
          {pending.length > 0 && (
            <>
              <button
                className="btn-primary ml-auto h-6 text-[11.5px]"
                onClick={() => void applyAllChatEdits(message.id, pending)}
                data-testid="agent-apply-all"
              >
                <CheckCheck size={12} /> {t("agent.applyAll", { count: pending.length })}
              </button>
              <button
                className="btn h-6 text-[11.5px]"
                onClick={() => rejectAllChatEdits(message.id, pending.map((p) => p.index))}
              >
                {t("agent.rejectAll")}
              </button>
            </>
          )}
        </div>
      )}
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <div key={i} className="whitespace-pre-wrap">
            {block.text.trim()}
          </div>
        ) : edits.has(i) ? (
          <EditCard
            key={i}
            messageId={message.id}
            index={edits.get(i)!.index}
            edit={edits.get(i)!.edit}
            state={message.editStates?.[edits.get(i)!.index]}
          />
        ) : (
          <div key={i} className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
            <pre className="max-h-72 overflow-auto bg-slate-50 p-2 font-mono text-[12px] whitespace-pre-wrap dark:bg-slate-900">{block.text}</pre>
            {message.status === "done" && message.anchor && (block.lang === "latex" || block.lang === "tex" || !block.lang) && (
              <div className="flex items-center gap-2 border-t border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800">
                <button
                  className="btn h-6 shrink-0 text-[11.5px] whitespace-nowrap"
                  data-testid="chat-review"
                  onClick={() => void reviewProposal(message.anchor!, block.text, message.instruction ?? "", message.provider ?? chatProvider())}
                >
                  <GitCompare size={12} /> {t("chat.reviewDiff")}
                </button>
                <span className="truncate text-[11px] text-slate-400">{t("chat.replaces", { count: message.anchor.text.length })}</span>
              </div>
            )}
          </div>
        ),
      )}
      {message.status === "streaming" && <span className="inline-block h-3 w-1.5 animate-pulse bg-slate-400" />}
      {message.status === "cancelled" && <div className="text-[11.5px] text-slate-400">{t("chat.stopped")}</div>}
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const running = useChat((s) => s.runningId !== null);
  const providerOverride = useChat((s) => s.provider);
  const defaultProvider = useSettings((s) => s.ai.defaultProvider);
  const models = useSettings((s) => s.ai.models);
  const provider = providerOverride ?? defaultProvider;
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    if (!draft.trim() || running) return;
    void sendChatMessage(draft);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#0f141b]" data-testid="chat-panel">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-2 dark:border-slate-800 dark:bg-[#121820]">
        <span className="panel-title whitespace-nowrap">{t("chat.title")}</span>
        <ProviderSelect value={provider} onChange={setChatProvider} className="ml-1 h-6 text-[12px]" />
        <span className="truncate text-[11px] text-slate-400" title={models[provider]}>
          {models[provider]}
        </span>
        <button className="icon-btn ml-auto" title={t("chat.clear")} onClick={clearChat}>
          <Trash2 size={12} />
        </button>
        <CollapseButton pane="chat" />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="space-y-2 text-[12.5px] text-slate-500">
            <p>{t("chat.intro")}</p>
            <div className="space-y-1">
              {EXAMPLES.map((key) => t(key)).map((example) => (
                <button
                  key={example}
                  className="block w-full rounded-md border border-slate-200 px-2 py-1 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  onClick={() => setDraft(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="ml-6">
              {message.contextLabel && <div className="mb-0.5 truncate text-right text-[10.5px] text-slate-400">{message.contextLabel}</div>}
              <div className="rounded-lg bg-sky-50 px-2.5 py-1.5 text-[13px] whitespace-pre-wrap text-slate-800 dark:bg-sky-950/50 dark:text-slate-100">
                {message.content}
              </div>
            </div>
          ) : (
            <div key={message.id} data-testid="chat-assistant">
              <div className="mb-0.5 text-[10.5px] text-slate-400">
                {message.provider ? PROVIDER_LABELS[message.provider] : ""} {message.model ? `(${message.model})` : ""}
              </div>
              <AssistantMessage message={message} />
            </div>
          ),
        )}
      </div>
      <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-800">
        <textarea
          ref={inputRef}
          data-testid="chat-input"
          className="input h-auto min-h-[60px] w-full resize-none py-1.5 leading-snug"
          placeholder={t("chat.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-1.5 flex items-center">
          <span className="text-[11px] text-slate-400">{t("chat.footer")}</span>
          {running ? (
            <button className="btn ml-auto" onClick={stopChat} data-testid="chat-stop">
              <Square size={11} /> {t("chat.stop")}
            </button>
          ) : (
            <button className="btn-primary ml-auto" onClick={send} disabled={!draft.trim()} data-testid="chat-send">
              <Send size={12} /> {t("chat.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
