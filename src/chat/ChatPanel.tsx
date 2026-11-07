import { Check, CheckCheck, FileText, Globe, History, MessageSquarePlus, Send, Square, Trash2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { lineOf, locateEdit, parseEditBody, type ProposedEdit } from "../ai/agent/edits";
import { chosenModels } from "../ai/models/modelConfig";
import type { ChatMode, WebEvidence } from "../ai/types";
import { PROVIDER_LABELS } from "../ai/providers/registry";
import { DiffView } from "../editor/inlineEdit/DiffView";
import { validateRewrite } from "../latex/validation";
import { confirmDialog, openExternal } from "../lib/backend";
import { timeAgo } from "../lib/time";
import { currentTexts, navigateTo } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { useT, type MessageKey } from "../i18n";
import { useSettings } from "../settings/settingsStore";
import { CollapseButton } from "../components/panes";
import {
  applyAllChatEdits,
  applyChatEdit,
  chatEditId,
  deleteChatSession,
  focusChatEdit,
  newChatSession,
  pendingEditLine,
  switchChatSession,
  rejectAllChatEdits,
  rejectChatEdit,
  sendChatMessage,
  setChatMode,
  setWebSearch,
  splitBlocks,
  stopChat,
  useChat,
  type ChatMessage,
  type EditState,
} from "./chatStore";
import type { ChatMarkdownProps } from "./markdown/ChatMarkdown";
import { fencedCode } from "./markdown/source";

const EXAMPLES: MessageKey[] = ["chat.example1", "chat.example2", "chat.example3", "chat.example4"];

function PlainText({ text }: ChatMarkdownProps) {
  return <div className="whitespace-pre-wrap">{text}</div>;
}

// The Markdown, math and highlighting code loads with the first answer, not with the app.
// Until then (or if it cannot load) the answer shows as plain text.
const ChatMarkdown = lazy<ComponentType<ChatMarkdownProps>>(() =>
  import("./markdown/ChatMarkdown").catch(() => ({ default: PlainText })),
);

function MarkdownBlock(props: ChatMarkdownProps) {
  return (
    <Suspense fallback={<PlainText {...props} />}>
      <ChatMarkdown {...props} />
    </Suspense>
  );
}

/** A link to a web page, opened in the system browser. */
function WebLink({ url, title, children, testId }: { url?: string; title?: string; children: ReactNode; testId?: string }) {
  if (!url) return <span title={title}>{children}</span>;
  return (
    <a
      href={url}
      title={title ?? url}
      className="break-words text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30"
      onClick={(e) => {
        e.preventDefault();
        void openExternal(url);
      }}
      data-testid={testId}
    >
      {children}
    </a>
  );
}

/** One proposed change: file, location, diff, checks, the web evidence it relies on, and Apply / Reject. */
function EditCard({ messageId, index, edit, state, exact = false, evidence = [] }: { messageId: string; index: number; edit: ProposedEdit; state?: EditState; exact?: boolean; evidence?: WebEvidence[] }) {
  const t = useT();
  const bibEntries = useProject((s) => s.bibEntries);
  useProject((s) => s.doc); // Recheck diff anchors when the author's source changes.
  const issues = useMemo(
    () => validateRewrite(edit.original, edit.revised, { bibKeys: new Set(bibEntries.map((e) => e.key)), allowEmpty: exact }),
    [edit, bibEntries, exact],
  );
  // A tool edit applies where its highlight is now; an older edit block by searching its text.
  const text = exact || state ? undefined : currentTexts().get(edit.path);
  const at = text === undefined ? null : locateEdit(text, edit.original);
  const line = state ? null : exact ? pendingEditLine(messageId, index, edit) : at && text !== undefined ? lineOf(text, at.from) : null;
  const errors = issues.filter((i) => i.severity === "error");
  return (
    <div
      className={`overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 ${state === "rejected" ? "opacity-50" : ""}`}
      data-testid="agent-edit"
      data-state={state ?? "pending"}
      data-edit-card={exact ? chatEditId(messageId, index) : undefined}
      onMouseEnter={exact && !state ? () => focusChatEdit(messageId, index, edit, true) : undefined}
      onMouseLeave={exact && !state ? () => focusChatEdit(messageId, index, edit, false) : undefined}
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
      {evidence.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1.5 border-b border-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-800" data-testid="agent-edit-evidence">
          <Globe size={11} className="shrink-0" /> {t("chat.evidenceUsed")}
          {evidence.map((e) => (
            <WebLink key={e.id} url={e.sources[0]?.url} title={e.finding}>
              {e.id}
            </WebLink>
          ))}
        </div>
      )}
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
            disabled={!line}
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

/** The question as rewritten by the Refine Module before answering. */
function RefinedLine({ message }: { message: ChatMessage }) {
  const t = useT();
  if (!message.refined || message.refined === message.instruction) return null;
  return (
    <div className="flex items-baseline gap-1.5 text-[11.5px] text-slate-500" data-testid="chat-refined">
      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        {t("chat.refined")}
      </span>
      <span className="min-w-0">{message.refined}</span>
    </div>
  );
}

/** The web pages a finished answer drew on; links open in the system browser. */
function SourceList({ message }: { message: ChatMessage }) {
  const t = useT();
  if (message.status !== "done" || !message.sources?.length) return null;
  return (
    <div className="border-t border-slate-100 pt-1.5 text-[11.5px] dark:border-slate-800" data-testid="chat-sources">
      <div className="mb-0.5 flex items-center gap-1 text-slate-500">
        <Globe size={11} /> {t("chat.sources")}
      </div>
      <ol className="list-decimal space-y-0.5 pl-5 text-slate-500">
        {message.sources.map((source) => (
          <li key={source.url}>
            <WebLink url={source.url} testId="chat-source">
              {source.title || source.url}
            </WebLink>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** An edit's web research: each finding with its sources, and what the search could not find. */
function EvidenceList({ message }: { message: ChatMessage }) {
  const t = useT();
  const evidence = message.evidence ?? [];
  const gaps = message.researchGaps ?? [];
  if (message.status !== "done" || (!evidence.length && !gaps.length)) return null;
  return (
    <div className="space-y-1 border-t border-slate-100 pt-1.5 text-[11.5px] dark:border-slate-800" data-testid="chat-evidence">
      {evidence.length > 0 && (
        <>
          <div className="flex items-center gap-1 text-slate-500">
            <Globe size={11} /> {t("chat.evidence")}
          </div>
          <ul className="space-y-1 text-slate-600 dark:text-slate-300">
            {evidence.map((e) => (
              <li key={e.id} data-testid="chat-evidence-item">
                <span className="mr-1.5 font-mono text-[10.5px] text-slate-400">{e.id}</span>
                {e.finding}
                <div className="flex flex-wrap gap-x-2 pl-6">
                  {e.sources.map((s) => (
                    <WebLink key={s.url} url={s.url} title={s.quote ? `"${s.quote}"` : s.url} testId="chat-source">
                      {s.title || s.url}
                    </WebLink>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {gaps.length > 0 && (
        <div className="text-slate-500" data-testid="chat-research-gaps">
          {t("chat.researchGaps")}
          <ul className="list-disc pl-5">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
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
  if (done && !message.truncated && !message.mode) {
    blocks.forEach((block, i) => {
      const edit = block.kind === "code" && block.lang === "edit" ? parseEditBody(block.meta ?? "", block.text) : null;
      if (edit) edits.set(i, { index: edits.size, edit });
    });
  }
  const toolEdits = done && !message.truncated && message.route === "edit" && message.mode !== "chat" ? message.edits ?? [] : [];
  const allEdits = toolEdits.length ? toolEdits.map((edit, index) => ({ index, edit })) : [...edits.values()];
  const pending = allEdits.filter(({ index }) => !message.editStates?.[index]);
  const streaming = message.status === "streaming";
  const searching = streaming && message.searchQuery !== undefined && !message.content;
  return (
    <div className="space-y-2">
      {(message.stage === "paper" || message.stage === "judge" || message.stage === "refine" || message.stage === "select") && (
        <div className="text-[11.5px] text-slate-500" data-testid="chat-stage">
          {t(message.stage === "paper" ? "chat.stagePaper" : message.stage === "judge" ? "chat.stageJudge" : message.stage === "select" ? "chat.stageSelect" : "chat.stageRefine")}
        </div>
      )}
      <RefinedLine message={message} />
      {searching && (
        <div className="flex items-center gap-1 text-[11.5px] text-slate-500" data-testid="chat-searching">
          <Globe size={11} className="shrink-0 animate-pulse" />
          <span className="min-w-0 truncate">{message.searchQuery ? t("chat.searchingFor", { query: message.searchQuery }) : t("chat.searching")}</span>
        </div>
      )}
      {(message.stage === "answer" || message.stage === "reply" || message.stage === "edit" || message.stage === "research") && !message.content && !searching && (
        <div className="text-[11.5px] text-slate-500" data-testid="chat-stage">
          {t(message.stage === "edit" ? "chat.stageEdit" : message.stage === "research" ? "chat.stageResearch" : message.stage === "answer" ? "chat.stageAnswer" : "chat.stageReply")}
        </div>
      )}
      {allEdits.length > 1 && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-slate-500" data-testid="agent-edits-bar">
          <span>{t("agent.edits", { count: allEdits.length })}</span>
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
          <MarkdownBlock key={i} text={block.text.trim()} streaming={streaming && i === blocks.length - 1} />
        ) : edits.has(i) ? (
          <EditCard
            key={i}
            messageId={message.id}
            index={edits.get(i)!.index}
            edit={edits.get(i)!.edit}
            state={message.editStates?.[edits.get(i)!.index]}
          />
        ) : (
          <MarkdownBlock
            key={i}
            text={fencedCode(block.text, block.lang)}
            streaming={streaming && i === blocks.length - 1}
          />
        ),
      )}
      {toolEdits.map((edit, index) => (
        <EditCard
          key={`tool-${index}`}
          messageId={message.id}
          index={index}
          edit={edit}
          state={message.editStates?.[index]}
          exact
          evidence={(edit.evidence ?? []).flatMap((id) => message.evidence?.filter((e) => e.id === id) ?? [])}
        />
      ))}
      {message.status === "streaming" && <span className="inline-block h-3 w-1.5 animate-pulse bg-slate-400" />}
      {message.evidence?.length || message.researchGaps?.length ? <EvidenceList message={message} /> : <SourceList message={message} />}
      {message.status === "cancelled" && <div className="text-[11.5px] text-slate-400">{t("chat.stopped")}</div>}
      {message.fallbackFrom && message.status === "done" && (
        <div className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="chat-fallback">
          {t("chat.fallbackUsed", { primary: message.fallbackFrom, fallback: message.model ?? "Claude" })}
        </div>
      )}
    </div>
  );
}

/** Saved conversations of this project: switch to one, or delete it. */
function SessionHistory() {
  const t = useT();
  const sessions = useChat((s) => s.sessions);
  const current = useChat((s) => s.sessionId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const remove = async (id: string, title: string) => {
    if (await confirmDialog(t("chat.deleteConfirm", { title: title || t("chat.untitled") }))) await deleteChatSession(id);
  };

  return (
    <div ref={ref} className="relative">
      <button
        className={`icon-btn ${open ? "bg-slate-200 dark:bg-slate-700" : ""}`}
        title={t("chat.history")}
        onClick={() => setOpen(!open)}
        data-testid="chat-history"
      >
        <History size={13} />
      </button>
      {open && (
        <div
          className="absolute top-7 right-0 z-40 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-[#151c26]"
          data-testid="chat-history-list"
        >
          <div className="border-b border-slate-100 px-3 py-1.5 text-[11.5px] font-semibold text-slate-500 dark:border-slate-800">{t("chat.history")}</div>
          <div className="max-h-80 overflow-y-auto py-1">
            {sessions.length === 0 && <div className="px-3 py-3 text-[12px] text-slate-400">{t("chat.noHistory")}</div>}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-2 px-3 py-1.5 ${s.id === current ? "bg-sky-50 dark:bg-sky-950/40" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"}`}
                data-testid="chat-session"
                data-current={s.id === current || undefined}
              >
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setOpen(false);
                    void switchChatSession(s.id);
                  }}
                >
                  <div className="truncate text-[12.5px] text-slate-800 dark:text-slate-100">{s.title || t("chat.untitled")}</div>
                  <div className="flex gap-2 text-[11px] text-slate-400">
                    <span>{timeAgo(s.updatedAt)}</span>
                    <span>{t("chat.messageCount", { count: s.messageCount })}</span>
                  </div>
                </button>
                <button
                  className="icon-btn h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 hover:text-red-600"
                  title={t("chat.deleteSession")}
                  onClick={() => void remove(s.id, s.title)}
                  data-testid="chat-session-delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400 dark:border-slate-800">{t("chat.savedLocally")}</div>
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const running = useChat((s) => s.runningId !== null);
  const mode = useChat((s) => s.mode);
  const webSearch = useChat((s) => s.webSearch);
  const defaultProvider = useSettings((s) => s.ai.defaultProvider);
  const chosen = useSettings((s) => s.ai.models);
  // Chat and Edit both answer with the model chosen in Settings.
  const config = chosenModels(defaultProvider, chosen);
  const models = t("chat.modelLabel", { primary: config.primary.model, fallback: config.fallback.model });
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const chatFontSize = useSettings((s) => s.editor.chatFontSize);
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
        <span className="ml-1 truncate text-[11px] text-slate-400" title={models} data-testid="chat-models">
          {models}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <SessionHistory />
          <button className="icon-btn" title={t("chat.new")} onClick={newChatSession} data-testid="chat-new">
            <MessageSquarePlus size={13} />
          </button>
          <CollapseButton pane="chat" />
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" style={{ fontSize: chatFontSize }}>
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
              <div className="mb-0.5 text-right text-[10px] text-slate-400">{message.mode === "chat" ? "Chat" : message.mode === "edit" ? "Edit" : "Auto"}{message.webSearch ? " · Web" : ""}</div>
              <div className="flex items-start justify-end gap-1.5">
                <div className="min-w-0 rounded-lg bg-sky-50 px-2.5 py-1.5 leading-normal whitespace-pre-wrap text-slate-800 dark:bg-sky-950/50 dark:text-slate-100">
                  {message.content}
                </div>
                <span className="shrink-0 pt-1 text-[14px] leading-none" aria-hidden>
                  👤
                </span>
              </div>
            </div>
          ) : (
            <div key={message.id} data-testid="chat-assistant" data-route={message.route}>
              <div className="mb-0.5 text-[10.5px] text-slate-400">
                {(message.route === "chat" || message.route === "edit") && <span className="mr-1.5" data-testid="chat-resolved-mode">{message.route === "edit" ? "Edit" : "Chat"}</span>}
                {message.provider ? PROVIDER_LABELS[message.provider] : ""} {message.model ? `(${message.model})` : ""}
              </div>
              <AssistantMessage message={message} />
            </div>
          ),
        )}
      </div>
      <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-800">
        <div className="flex items-end gap-1.5">
        <div className="flex w-[76px] shrink-0 flex-col gap-1">
        <button
          type="button"
          onClick={() => setWebSearch(!webSearch)}
          disabled={running}
          aria-pressed={webSearch}
          aria-label={t("chat.webSearch")}
          title={t(webSearch ? "chat.webSearchOn" : "chat.webSearchOff")}
          className={`flex h-6 items-center justify-center gap-1 rounded-md border text-[11px] disabled:cursor-not-allowed disabled:opacity-50 ${
            webSearch
              ? "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950/50 dark:text-sky-300"
              : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          }`}
          data-testid="chat-web-search"
        >
          <Globe size={11} /> Web
        </button>
        <select
          value={mode}
          onChange={(e) => setChatMode(e.target.value as ChatMode)}
          disabled={running}
          aria-label={t("chat.mode")}
          title={t(mode === "chat" ? "chat.modeChat" : mode === "edit" ? "chat.modeEdit" : "chat.modeAuto")}
          className="input h-8 w-full px-1.5 text-[12px]"
          data-testid="chat-mode"
        >
          <option value="chat">Chat</option>
          <option value="edit">Edit</option>
          <option value="auto">Auto</option>
        </select>
        </div>
        <textarea
          ref={inputRef}
          data-testid="chat-input"
          className="input h-auto min-h-[60px] min-w-0 flex-1 resize-none py-1.5 leading-snug"
          placeholder={t(mode === "chat" ? "chat.placeholderChat" : mode === "edit" ? "chat.placeholderEdit" : "chat.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        </div>
        <div className="mt-1.5 flex items-center">
          <span className="min-w-0 text-[11px] text-slate-400">{t(mode === "chat" ? "chat.modeChat" : "chat.footer")}</span>
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
