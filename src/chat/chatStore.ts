/**
 * Chat about the current paper, run as a three-step pipeline:
 *
 *   👤 User → Intent Module → Answer Agent → 💬 Answer
 *
 * The Intent Module works out what the user wants to know; the Answer Agent
 * answers from the whole paper with that intent. In development every step
 * is reported to the localhost visual debugger (see `src/debug/trace.ts`).
 */
import { create } from "zustand";
import { buildChatContext } from "../ai/context/contextBuilder";
import { paragraphContext } from "../ai/context/paragraphs";
import { AIError } from "../ai/errors";
import { MAX_OUTPUT_TOKENS } from "../ai/models/modelConfig";
import { aiService, newRequestId } from "../ai/service";
import { lineOf, locateEdit, type ProposedEdit } from "../ai/agent/edits";
import { parseIntent } from "../ai/agent/intent";
import { deleteSession, listSessions, loadSession, newSessionId, saveSession, SESSION_VERSION, type SessionSummary } from "./chatHistory";
import { buildPrompt } from "../ai/prompts";
import { failSpan, spanData, startSpan, endSpan, step, traced, type Span } from "../debug/trace";
import type { AIContext, AIMessage, AIRequest, AIResponse, ProjectFile, ProviderId, QuestionIntent } from "../ai/types";
import { editorSession } from "../editor/editorSession";
import { outlineText, sectionAt, sectionTrail } from "../latex/parser/documentModel";
import { currentTexts, navigateTo, openFile } from "../project/projectActions";
import { notify, useProject } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";
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
  /** Pipeline step running for this answer. */
  stage?: "intent" | "agent";
  /** What the Intent Module understood the question as. */
  intent?: QuestionIntent;
}

export type EditState = "applied" | "rejected" | "failed";

interface ChatState {
  messages: ChatMessage[];
  /** Provider override for the chat; null means the default provider. */
  provider: ProviderId | null;
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
  provider: null,
  runningId: null,
  root: null,
  sessionId: newSessionId(),
  createdAt: Date.now(),
  sessions: [],
}));

const MAX_HISTORY_MESSAGES = 12;
/** Earlier messages the Intent Module sees (to resolve follow-up questions). */
const INTENT_HISTORY_MESSAGES = 4;
/** Characters of paper source sent to the Answer Agent (roughly 40k tokens). */
const PAPER_BUDGET = 150_000;

/**
 * The whole paper for the Answer Agent: the main file and the files it
 * includes, in reading order, as long as they fit the budget. A file open in
 * the editor that is not part of the paper goes first.
 */
function paperFiles(activePath: string | undefined): { files: ProjectFile[]; omitted: string[] } {
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
  return { files, omitted };
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

export function chatProvider(): ProviderId {
  return useChat.getState().provider ?? useSettings.getState().ai.defaultProvider;
}

function updateMessage(id: string, patch: Partial<ChatMessage>) {
  useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
}

/** Provider request currently running for the chat. */
let activeRequest: string | null = null;
/** Answers the author stopped, so the next step is not started. */
const stopped = new Set<string>();

interface Turn {
  id: string;
  provider: ProviderId;
  model: string;
  instruction: string;
  selectedText?: string;
  context: AIContext;
  history: AIMessage[];
  activePath?: string;
}

/** The exact system prompt and messages a provider receives, for the debugger. */
function promptText(request: AIRequest): string {
  const payload = buildPrompt(request);
  return [`[system]\n${payload.system}`, ...payload.messages.map((m) => `[${m.role}]\n${m.content}`)].join("\n\n");
}

/** One model call through the AI service (the Rust transport reports its own span under it). */
async function run(turn: Turn, parent: Span, request: AIRequest, onText?: (text: string) => void): Promise<AIResponse> {
  activeRequest = request.id;
  const span = startSpan(
    turn.id,
    parent,
    "llm",
    "aiService.generate",
    () => ({ provider: turn.provider, model: turn.model, task: request.task, request_id: request.id, prompt_chars: promptText(request).length }),
    request.id,
  );
  let first = true;
  const started = performance.now();
  try {
    const response = await aiService.generate(turn.provider, request, {
      onDelta: (_d, full) => {
        if (first) {
          first = false;
          spanData(span, "llm", "first_text", () => ({ ms: Math.round(performance.now() - started) }));
        }
        onText?.(full);
      },
    });
    endSpan(span, "llm", () => ({ text: response.text, finishReason: response.finishReason, usage: response.usage }));
    return response;
  } catch (err) {
    failSpan(span, "llm", err);
    throw err;
  } finally {
    activeRequest = null;
    if (stopped.has(turn.id)) throw new AIError("cancelled", t("chat.stopped"), { provider: turn.provider });
  }
}

function base(turn: Turn): Pick<AIRequest, "instruction" | "selectedText" | "model"> {
  return { instruction: turn.instruction, selectedText: turn.selectedText, model: turn.model };
}

/** What the user is looking at, as handed from the user input to the Intent Module. */
function editorLocation(turn: Turn) {
  return {
    file: turn.context.currentFile ?? null,
    section: turn.context.currentSection ?? null,
    selected_text: turn.selectedText ?? null,
    cursor_paragraph: turn.selectedText ? null : (turn.context.currentParagraph ?? null),
  };
}

/** Step 1: work out what the user wants to know. */
function runIntentModule(turn: Turn, root: Span): Promise<QuestionIntent> {
  const history = turn.history.slice(-INTENT_HISTORY_MESSAGES);
  return traced(
    turn.id,
    root,
    "intent",
    "runIntentModule",
    () => ({ question: turn.instruction, ...editorLocation(turn), history_pairs: history.length / 2 }),
    async (span) => {
      const request: AIRequest = {
        ...base(turn),
        id: `${turn.id}-intent`,
        task: "intent",
        context: {
          paperTitle: turn.context.paperTitle,
          outline: turn.context.outline,
          currentFile: turn.context.currentFile,
          currentSection: turn.context.currentSection,
          currentParagraph: turn.context.currentParagraph,
        },
        history,
        maxOutputTokens: MAX_OUTPUT_TOKENS.intent,
      };
      step(turn.id, span, "intent", "buildIntentPrompt", () => ({ task: "intent", history_pairs: history.length / 2 }), () => promptText(request));
      const response = await run(turn, span, request);
      const intent = parseIntent(response.text, turn.instruction);
      step(turn.id, span, "intent", "parseIntent", response.text, intent);
      return intent;
    },
  );
}

/** Step 2: answer from the whole paper with the intent. */
function runAnswerAgent(turn: Turn, root: Span, intent: QuestionIntent): Promise<AIResponse> {
  return traced(
    turn.id,
    root,
    "agent",
    "runAnswerAgent",
    () => ({ question: turn.instruction, intent, history_pairs: turn.history.length / 2 }),
    async (span) => {
      const { files, omitted } = paperFiles(turn.activePath);
      step(
        turn.id,
        span,
        "agent",
        "paperFiles",
        { budget_chars: PAPER_BUDGET, active_file: turn.activePath ?? null },
        () => ({
          files: files.map((f) => ({ path: f.path, chars: f.text.length })),
          omitted,
          total_chars: files.reduce((n, f) => n + f.text.length, 0),
          text: files.map((f) => `% ---- ${f.path}\n${f.text}`).join("\n"),
        }),
      );
      const request: AIRequest = {
        ...base(turn),
        id: turn.id,
        task: "answer",
        context: {
          currentFile: turn.context.currentFile,
          currentSection: turn.context.currentSection,
          currentParagraph: turn.context.currentParagraph,
        },
        history: turn.history,
        projectFiles: files,
        omittedFiles: omitted,
        intent,
        maxOutputTokens: MAX_OUTPUT_TOKENS.answer,
      };
      step(turn.id, span, "agent", "buildAnswerPrompt", () => ({ task: "answer", intent, files: files.length }), () => promptText(request));
      updateMessage(turn.id, { stage: "agent", intent });
      return run(turn, span, request, (full) => updateMessage(turn.id, { content: full }));
    },
    (response) => ({ text: response.text, finishReason: response.finishReason }),
  );
}

export async function sendChatMessage(text: string): Promise<void> {
  const instruction = text.trim();
  if (!instruction || useChat.getState().runningId) return;
  const provider = chatProvider();
  const model = useSettings.getState().ai.models[provider];
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
    provider,
    model,
    instruction,
    selectedText: snapshot && snapshot.from !== snapshot.to ? snapshot.text : undefined,
    context,
    history: conversation(),
    activePath: snapshot?.path,
  };

  const userMessage: ChatMessage = { id: `${requestId}-u`, role: "user", content: instruction, status: "done", contextLabel };
  const assistantMessage: ChatMessage = {
    id: requestId,
    role: "assistant",
    content: "",
    status: "streaming",
    provider,
    model,
    anchor,
    instruction,
    stage: "intent",
  };
  useChat.setState((s) => ({ messages: [...s.messages, userMessage, assistantMessage], runningId: requestId }));

  // One trace per question; its id is the answer's message id.
  const root = startSpan(requestId, null, "pipeline", "sendChatMessage", () => ({ question: instruction, provider, model }));
  step(requestId, root, "user", "receiveUserInput", instruction, () => ({ question: instruction, ...editorLocation(turn), history_pairs: turn.history.length / 2 }));
  try {
    const intent = await runIntentModule(turn, root);
    const response = await runAnswerAgent(turn, root, intent);
    const content = response.text + (response.finishReason === "length" ? `\n\n${t("chat.truncated")}` : "");
    updateMessage(requestId, { content, status: "done", stage: undefined });
    step(requestId, root, "answer", "showFinalAnswer", content, () => ({
      finishReason: response.finishReason,
      usage: response.usage,
      edit_blocks: splitBlocks(content).filter((b) => b.kind === "code" && b.lang === "edit").length,
    }));
    endSpan(root, "pipeline", { status: "done" });
  } catch (err) {
    const error = err instanceof AIError ? err : new AIError("unknown", String(err));
    if (error.kind === "cancelled") updateMessage(requestId, { status: "cancelled", stage: undefined });
    else updateMessage(requestId, { status: "error", stage: undefined, content: error.message });
    failSpan(root, "pipeline", error);
  } finally {
    stopped.delete(requestId);
    useChat.setState({ runningId: null });
  }
}

export function stopChat() {
  const { runningId } = useChat.getState();
  if (!runningId) return;
  stopped.add(runningId);
  if (activeRequest) void aiService.cancel(activeRequest);
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

export function setChatProvider(provider: ProviderId) {
  useChat.setState({ provider });
}

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
