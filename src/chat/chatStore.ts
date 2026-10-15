/**
 * Chat about the current paper.
 *
 * This store holds the conversation; each question is run by the Chat
 * Orchestrator (`./orchestrator.ts`), which decides whether to reply
 * directly, answer, or refine the question first, and reports every step to
 * the localhost runtime debugger in development.
 */
import { create } from "zustand";
import { buildChatContext } from "../ai/context/contextBuilder";
import { paragraphContext } from "../ai/context/paragraphs";
import { AIError } from "../ai/errors";
import type { RunControl } from "../ai/gateway";
import { CHAT_MODELS } from "../ai/models/modelConfig";
import { aiService, newRequestId } from "../ai/service";
import { lineOf, locateEdit, type ProposedEdit } from "../ai/agent/edits";
import { deleteSession, listSessions, loadSession, newSessionId, saveSession, SESSION_VERSION, type SessionSummary } from "./chatHistory";
import { editorLocation, runChatTurn, type Outcome, type Paper, type Stage, type Turn } from "./orchestrator";
import { endSpan, failSpan, startSpan, step } from "../debug/trace";
import type { AIContext, AIMessage, ProjectFile, ProviderId } from "../ai/types";
import { editorSession } from "../editor/editorSession";
import { outlineText, sectionAt, sectionTrail } from "../latex/parser/documentModel";
import { currentTexts, navigateTo, openFile } from "../project/projectActions";
import { notify, useProject } from "../project/projectStore";
import { t } from "../i18n";

export interface ChatAnchor {
  path: string;
  from: number;
  to: number;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "streaming" | "error" | "cancelled";
  /** The model that wrote the answer (the one running while it streams). */
  provider?: ProviderId;
  model?: string;
  /** Text the conversation turn was about (selection or paragraph). */
  anchor?: ChatAnchor;
  /** Short description of the editor context sent with the message. */
  contextLabel?: string;
  /** The user instruction an assistant message answers. */
  instruction?: string;
  /** Outcome of each proposed edit block, by its index in the answer. */
  editStates?: Record<number, EditState>;
  /** Step of the turn running for this answer. */
  stage?: Stage;
  /** How the turn ended: direct reply, answer, or a question back. */
  route?: Outcome;
  /** The question as rewritten by the Refine Module. */
  refined?: string;
  /** The OpenAI model that failed when Claude wrote this answer. */
  fallbackFrom?: string;
}

export type EditState = "applied" | "rejected" | "failed";

interface ChatState {
  messages: ChatMessage[];
  runningId: string | null;
  /** Project the conversation belongs to, and the session being shown. */
  root: string | null;
  sessionId: string;
  createdAt: number;
  /** Saved conversations of this project, most recent first. */
  sessions: SessionSummary[];
}

export const useChat = create<ChatState>()(() => ({
  messages: [],
  runningId: null,
  root: null,
  sessionId: newSessionId(),
  createdAt: Date.now(),
  sessions: [],
}));

const MAX_HISTORY_MESSAGES = 12;
/** Characters of paper source sent to the Refine and Answer modules (roughly 40k tokens). */
const PAPER_BUDGET = 150_000;

/**
 * The whole paper: the main file and the files it includes, in reading
 * order, as long as they fit the budget. A file open in the editor that is
 * not part of the paper goes first.
 */
function paperFiles(activePath: string | undefined): Paper {
  const { doc } = useProject.getState();
  const texts = currentTexts();
  const paths = (doc?.files ?? []).filter((f) => f.included && !f.missing).map((f) => f.path);
  if (activePath && texts.has(activePath) && !paths.includes(activePath)) paths.unshift(activePath);
  const files: ProjectFile[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const path of new Set(paths)) {
    const text = texts.get(path);
    if (text === undefined) continue;
    if (used + text.length > PAPER_BUDGET) {
      omitted.push(path);
      continue;
    }
    files.push({ path, text });
    used += text.length;
  }
  return { files, omitted, budget: PAPER_BUDGET };
}

/** Finished question and answer pairs; a question whose answer failed is left out. */
function conversation(): AIMessage[] {
  const { messages } = useChat.getState();
  const out: AIMessage[] = [];
  messages.forEach((m, i) => {
    const question = messages[i - 1];
    if (m.role !== "assistant" || m.status !== "done" || !m.content.trim() || question?.role !== "user") return;
    out.push({ role: "user", content: question.content }, { role: "assistant", content: m.content });
  });
  return out.slice(-MAX_HISTORY_MESSAGES);
}

function updateMessage(id: string, patch: Partial<ChatMessage>) {
  useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
}

/** The turn running now, so it can be stopped. */
let running: RunControl | null = null;

export async function sendChatMessage(text: string): Promise<void> {
  const instruction = text.trim();
  if (!instruction || useChat.getState().runningId) return;
  const { doc, name } = useProject.getState();
  const snapshot = editorSession.selection();

  let anchor: ChatAnchor | undefined;
  let contextLabel = t("chat.noFile");
  let context: AIContext = {};
  if (snapshot) {
    context = buildChatContext(
      doc,
      { projectName: name, filePath: snapshot.path, text: snapshot.docText, selectionFrom: snapshot.from, selectionTo: snapshot.to },
      currentTexts(),
    );
    const range =
      snapshot.from !== snapshot.to
        ? { from: snapshot.from, to: snapshot.to }
        : paragraphContext(snapshot.docText, snapshot.from, snapshot.to).currentRange;
    if (range) anchor = { path: snapshot.path, ...range, text: snapshot.docText.slice(range.from, range.to) };
    const line = snapshot.docText.slice(0, snapshot.from).split("\n").length;
    const section = doc ? sectionAt(doc, snapshot.path, line) : null;
    const where = section ? (section.order >= 0 && doc ? sectionTrail(doc, section) : section.title) : snapshot.path;
    contextLabel = `${snapshot.path} › ${where}${snapshot.from !== snapshot.to ? ` ${t("chat.charsSelected", { count: snapshot.to - snapshot.from })}` : ""}`;
  } else if (doc) {
    context = { paperTitle: doc.title, outline: doc.flatSections.length ? outlineText(doc) : undefined };
  }

  const requestId = newRequestId();
  const turn: Turn = {
    id: requestId,
    instruction,
    selectedText: snapshot && snapshot.from !== snapshot.to ? snapshot.text : undefined,
    context,
    history: conversation(),
    activePath: snapshot?.path,
  };

  const first = CHAT_MODELS.judge.primary;
  const userMessage: ChatMessage = { id: `${requestId}-u`, role: "user", content: instruction, status: "done", contextLabel };
  const assistantMessage: ChatMessage = {
    id: requestId,
    role: "assistant",
    content: "",
    status: "streaming",
    provider: first.provider,
    model: first.model,
    anchor,
    instruction,
    stage: "judge",
  };
  useChat.setState((s) => ({ messages: [...s.messages, userMessage, assistantMessage], runningId: requestId }));

  // One trace per question; its id is the answer's message id.
  const root = startSpan(requestId, null, "pipeline", "sendChatMessage", () => ({ question: instruction, models: CHAT_MODELS }));
  step(requestId, root, "user", "receiveUserInput", instruction, () => ({ question: instruction, ...editorLocation(turn), history_pairs: turn.history.length / 2 }));
  const control: RunControl = { stopped: false, activeRequest: null };
  running = control;
  try {
    const result = await runChatTurn(turn, {
      root,
      control,
      paper: () => paperFiles(turn.activePath),
      hooks: {
        onStage: (stage) => updateMessage(requestId, { stage }),
        onRefined: (refined) => updateMessage(requestId, { refined }),
        onText: (full) => updateMessage(requestId, { content: full }),
        onModel: (choice) => updateMessage(requestId, { provider: choice.provider, model: choice.model }),
      },
    });
    const content = result.content + (result.finishReason === "length" ? `\n\n${t("chat.truncated")}` : "");
    updateMessage(requestId, {
      content,
      status: "done",
      stage: undefined,
      route: result.outcome,
      provider: result.choice.provider,
      model: result.choice.model,
      fallbackFrom: result.fallbackFrom?.model,
    });
    step(requestId, root, "final", "showFinalAnswer", content, () => ({
      route: result.route,
      outcome: result.outcome,
      model: result.choice.model,
      fallback_from: result.fallbackFrom?.model ?? null,
      finishReason: result.finishReason,
      usage: result.usage,
      edit_blocks: splitBlocks(content).filter((b) => b.kind === "code" && b.lang === "edit").length,
    }));
    endSpan(root, "pipeline", { status: "done", route: result.route, outcome: result.outcome });
  } catch (err) {
    const error = err instanceof AIError ? err : new AIError("unknown", String(err));
    if (error.kind === "cancelled") updateMessage(requestId, { status: "cancelled", stage: undefined });
    else updateMessage(requestId, { status: "error", stage: undefined, content: error.message });
    failSpan(root, "pipeline", error);
  } finally {
    if (running === control) running = null;
    useChat.setState({ runningId: null });
  }
}

export function stopChat() {
  const control = running;
  if (!control) return;
  control.stopped = true;
  if (control.activeRequest) void aiService.cancel(control.activeRequest);
}

// ---------------------------------------------------------------- saved sessions

/** Load the project's conversations and show the most recent one (or a new one). */
export async function openChatsFor(root: string | null): Promise<void> {
  stopChat();
  clearTimeout(saveTimer);
  useChat.setState({ root, messages: [], sessions: [], sessionId: newSessionId(), createdAt: Date.now() });
  if (!root) return;
  const sessions = await listSessions(root).catch(() => [] as SessionSummary[]);
  if (useChat.getState().root !== root) return;
  useChat.setState({ sessions });
  if (sessions[0]) await switchChatSession(sessions[0].id);
}

/** Start an empty conversation; it is saved once it has a message. */
export function newChatSession() {
  stopChat();
  flushSave();
  useChat.setState({ messages: [], sessionId: newSessionId(), createdAt: Date.now() });
}

export async function switchChatSession(id: string): Promise<void> {
  const { root } = useChat.getState();
  if (!root) return;
  stopChat();
  flushSave();
  const file = await loadSession<ChatMessage>(root, id).catch(() => null);
  if (!file || useChat.getState().root !== root) return;
  // An answer that was still streaming when the app closed is shown as stopped.
  const messages = file.messages.map((m) => (m.status === "streaming" ? { ...m, status: "cancelled" as const, stage: undefined } : m));
  useChat.setState({ messages, sessionId: id, createdAt: file.createdAt });
}

export async function deleteChatSession(id: string): Promise<void> {
  const { root, sessionId } = useChat.getState();
  if (!root) return;
  if (id === sessionId) {
    // Leave the conversation first so nothing saves it again while it is being removed.
    stopChat();
    clearTimeout(saveTimer);
    useChat.setState({ messages: [], sessionId: newSessionId(), createdAt: Date.now() });
  }
  await deleteSession(root, id);
  const sessions = useChat.getState().sessions.filter((s) => s.id !== id);
  useChat.setState({ sessions });
  if (id === sessionId && sessions[0]) await switchChatSession(sessions[0].id);
}

const SAVE_DELAY_MS = 500;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function sessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/** Write the shown conversation now (when it has messages and no answer is streaming). */
function flushSave() {
  clearTimeout(saveTimer);
  const { root, sessionId, createdAt, messages, runningId, sessions } = useChat.getState();
  if (!root || messages.length === 0 || runningId) return;
  const updatedAt = Date.now();
  void saveSession(root, sessionId, { version: SESSION_VERSION, createdAt, updatedAt, messages }).catch(() => {
    // Saving is best effort; the conversation stays usable in memory.
  });
  const summary: SessionSummary = { id: sessionId, title: sessionTitle(messages), createdAt, updatedAt, messageCount: messages.length };
  useChat.setState({ sessions: [summary, ...sessions.filter((s) => s.id !== sessionId)] });
}

// Save shortly after the conversation changes (new message, finished answer, applied edit).
useChat.subscribe((state, prev) => {
  if (state.messages === prev.messages && state.runningId === prev.runningId) return;
  if (state.sessionId !== prev.sessionId || state.root !== prev.root) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
});

export interface Block {
  kind: "text" | "code";
  lang?: string;
  /** Rest of the fence line after the language (the file path of an edit block). */
  meta?: string;
  text: string;
}

/** Split an assistant answer into text and fenced code blocks. */
export function splitBlocks(content: string): Block[] {
  const parts: Block[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:\n```|$)/g;
  let last = 0;
  for (const m of content.matchAll(fence)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: content.slice(last, index) });
    const [lang, ...meta] = m[1].trim().split(/\s+/);
    parts.push({ kind: "code", lang: lang || undefined, meta: meta.join(" ") || undefined, text: m[2].replace(/\n$/, "") });
    last = index + m[0].length;
  }
  if (last < content.length) parts.push({ kind: "text", text: content.slice(last) });
  return parts.filter((p) => p.text.trim());
}

// ---------------------------------------------------------------- agent edits

function setEditState(messageId: string, index: number, state: EditState) {
  useChat.setState((s) => ({
    messages: s.messages.map((m) => (m.id === messageId ? { ...m, editStates: { ...m.editStates, [index]: state } } : m)),
  }));
}

/** Apply one proposed edit to its file (opened in the background if needed). */
async function applyEdit(edit: ProposedEdit): Promise<{ path: string; line: number } | null> {
  if (!editorSession.has(edit.path) && !(await openFile(edit.path, { activate: false }))) return null;
  const text = editorSession.textOf(edit.path);
  const at = text === undefined ? null : locateEdit(text, edit.original);
  if (!text || !at) return null;
  editorSession.applyEdit(edit.path, at.from, at.to, edit.revised);
  return { path: edit.path, line: lineOf(text, at.from) };
}

export async function applyChatEdit(messageId: string, index: number, edit: ProposedEdit) {
  const done = await applyEdit(edit);
  setEditState(messageId, index, done ? "applied" : "failed");
  if (done) await navigateTo(done.path, done.line);
}

export function rejectChatEdit(messageId: string, index: number) {
  setEditState(messageId, index, "rejected");
}

/** Apply every edit of an answer that is still pending, in order. */
export async function applyAllChatEdits(messageId: string, edits: { index: number; edit: ProposedEdit }[]) {
  let applied = 0;
  let failed = 0;
  for (const { index, edit } of edits) {
    const done = await applyEdit(edit);
    setEditState(messageId, index, done ? "applied" : "failed");
    if (done) applied++;
    else failed++;
  }
  if (applied) notify("success", t("agent.appliedCount", { count: applied }));
  if (failed) notify("error", t("agent.failedCount", { count: failed }));
}

export function rejectAllChatEdits(messageId: string, indexes: number[]) {
  for (const index of indexes) setEditState(messageId, index, "rejected");
}
