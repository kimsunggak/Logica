/**
 * Conversation state, frozen UI modes, queued paper edit tool calls and saved sessions.
 * Paper Orchestra runs common refinement, routing, source selection and Chat/Edit.
 * Session and paper summaries run independently in the background; accepted source
 * edits use the editor's normal save and undo workflow and refresh paper summaries.
 */
import { create } from "zustand";
import { AIError } from "../ai/errors";
import type { RunControl } from "../ai/gateway";
import { CHAT_MODELS } from "../ai/models/modelConfig";
import { aiService, newRequestId } from "../ai/service";
import { lineOf, locateEdit, parseEditBody, type ProposedEdit } from "../ai/agent/edits";
import { preparePaperEdits, validEditPath } from "./paper/editTool";
import { deleteSession, listSessions, loadSession, newSessionId, saveSession, SESSION_VERSION, type SessionSummary } from "./chatHistory";
import { runChatTurn, type Outcome, type Paper, type Route, type Stage, type Turn } from "./orchestrator";
import { emptyReport, hasSummaries, loadReport, saveReport, summariesFor, unitsToSummarize, withSummaries, type PaperReport } from "./paper/report";
import { summarizeSections } from "./paper/sectionSummarizer";
import { paperUnits } from "./paper/sections";
import { foldTurns, moduleChars, turnsToFold, unsummarized } from "./session/summarizer";
import { readSummary, type ConversationSummary } from "./session/summary";
import { turnsOf } from "./session/turns";
import { endSpan, failSpan, setDebugProject, startSpan, step, type Span } from "../debug/trace";
import type { ChatMode, ProjectFile, ProviderId } from "../ai/types";
import { editorSession } from "../editor/editorSession";
import { buildPaperDocument, outlineText } from "../latex/parser/documentModel";
import { currentTexts, navigateTo, openFile } from "../project/projectActions";
import { notify, useProject } from "../project/projectStore";
import { t } from "../i18n";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** UI purpose frozen when this turn was sent. Old messages default to Auto. */
  mode?: ChatMode;
  status: "done" | "streaming" | "error" | "cancelled";
  /** The model that wrote the answer (the one running while it streams). */
  provider?: ProviderId;
  model?: string;
  /** The user instruction an assistant message answers. */
  instruction?: string;
  /** Outcome of each proposed edit block, by its index in the answer. */
  editStates?: Record<number, EditState>;
  /** Validated arguments of the queued apply_paper_edits tool call. */
  edits?: ProposedEdit[];
  editToolCallId?: string;
  /** Step of the turn running for this answer. */
  stage?: Stage;
  /** How the turn ended: direct reply, answer, or a question back. */
  route?: Outcome;
  /** The question as rewritten by the Refine Module. */
  refined?: string;
  /** The OpenAI model that failed when Claude wrote this answer. */
  fallbackFrom?: string;
  /** The answer hit the output limit. */
  truncated?: boolean;
}

export type EditState = "applied" | "rejected" | "failed";

interface ChatState {
  mode: ChatMode;
  messages: ChatMessage[];
  runningId: string | null;
  /** Project the conversation belongs to, and the session being shown. */
  root: string | null;
  sessionId: string;
  createdAt: number;
  /** Older turns of the shown conversation, summarized (L1). */
  summary: ConversationSummary | null;
  /** Saved conversations of this project, most recent first. */
  sessions: SessionSummary[];
}

export const useChat = create<ChatState>()(() => ({
  mode: "auto",
  messages: [],
  runningId: null,
  root: null,
  sessionId: newSessionId(),
  createdAt: Date.now(),
  summary: null,
  sessions: [],
}));

/** Characters of paper source sent to the Refine and Answer modules (roughly 40k tokens). */
const PAPER_BUDGET = 150_000;

/** The paper as it is now, with unsaved changes: its model and its `.tex` sources. */
function paperNow() {
  const texts = currentTexts();
  const tex = new Map([...texts].filter(([path]) => path.endsWith(".tex")));
  return { texts, tex, doc: buildPaperDocument({ mainFile: useProject.getState().mainFile, files: tex }) };
}

/**
 * The paper as this turn reads it. The whole paper is the main file and the
 * files it includes, in reading order, as long as they fit the budget. Its
 * section units come with the summaries the paper report has for them.
 */
function paperOf(report: PaperReport): Paper {
  const { texts, tex, doc } = paperNow();
  const paths = doc.files.filter((f) => f.included && !f.missing).map((f) => f.path);
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
  const { units, macros } = paperUnits(doc, tex);
  return { files, omitted, budget: PAPER_BUDGET, units, summaries: summariesFor(units, report), macros };
}

/**
 * The first question about a paper: summarize all its sections before the
 * judge runs, so that the first answer, like every later one, reads only the
 * sections it needs word for word. It runs once per paper; sections edited
 * later are summarized after a turn. A failure leaves the summary as it was,
 * and this turn reads the whole paper.
 */
async function summarizeFirst(project: string, report: PaperReport, run: { traceId: string; root: Span; control: RunControl; onStart: () => void }): Promise<PaperReport> {
  const { tex, doc } = paperNow();
  const { units } = paperUnits(doc, tex);
  if (!units.length) return report;
  if (hasSummaries(units, report)) {
    const next = withSummaries(report, [], units);
    const metadataChanged = units.some((unit) => unit.summary !== undefined && report.summaries[unit.hash]?.summary !== unit.summary);
    if (metadataChanged || Object.keys(next.summaries).length !== Object.keys(report.summaries).length) {
      await saveReport(project, next, units, doc.title);
      return next;
    }
    return report;
  }
  // A run in the background may be writing the first summaries already.
  if (sectioning) {
    await sectioning.done;
    const latest = await loadReport(project);
    if (hasSummaries(units, latest)) return latest;
  }
  run.onStart();
  try {
    const result = await summarizeSections(unitsToSummarize(units, report), {
      traceId: run.traceId,
      parent: run.root,
      control: run.control,
      title: doc.title,
      outline: doc.flatSections.length ? outlineText(doc, 3000) : undefined,
    });
    if (!result.summarized.length) return report;
    const next = withSummaries(await loadReport(project), result.summarized, units);
    await saveReport(project, next, units, doc.title);
    return next;
  } catch (err) {
    if (run.control.stopped || (err instanceof AIError && err.kind === "cancelled")) throw err;
    return report;
  }
}

function updateMessage(id: string, patch: Partial<ChatMessage>) {
  useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
}

/** The turn running now, so it can be stopped. */
let running: RunControl | null = null;

export function setChatMode(mode: ChatMode) {
  if (mode === "auto" || mode === "chat" || mode === "edit") useChat.setState({ mode });
}

export async function sendChatMessage(text: string): Promise<void> {
  const instruction = text.trim();
  if (!instruction || useChat.getState().runningId) return;
  const { mode, root: projectRoot, sessionId } = useChat.getState();
  // Only the question goes; the editor's open file, selection and cursor
  // often have nothing to do with what is asked.
  const requestId = newRequestId();
  const turn: Turn = {
    id: requestId,
    instruction,
    mode,
    turns: turnsOf(useChat.getState().messages),
    summary: useChat.getState().summary,
  };

  const first = CHAT_MODELS.refine.primary;
  const userMessage: ChatMessage = { id: `${requestId}-u`, role: "user", content: instruction, status: "done", mode };
  const assistantMessage: ChatMessage = {
    id: requestId,
    role: "assistant",
    content: "",
    mode,
    status: "streaming",
    provider: first.provider,
    model: first.model,
    instruction,
    stage: "refine",
  };
  useChat.setState((s) => ({ messages: [...s.messages, userMessage, assistantMessage], runningId: requestId }));

  // One trace per question; its id is the answer's message id.
  const root = startSpan(requestId, null, "pipeline", "sendChatMessage", () => ({ question: instruction, ui_mode: mode, models: CHAT_MODELS }));
  step(requestId, root, "user", "receiveUserInput", instruction, () => ({
    question: instruction,
    ui_mode: mode,
    session_turns: turn.turns.length,
    summary_covered_turns: turn.summary?.coveredTurns ?? 0,
    // How close the earlier turns are to the Session Summary Module's length limit.
    unsummarized_chars: moduleChars(unsummarized(turn.turns, turn.summary ?? null)),
  }));
  const control: RunControl = { stopped: false, activeRequest: null };
  running = control;
  let route: Route | undefined;
  try {
    const project = useProject.getState().root;
    let report = project ? await loadReport(project) : emptyReport();
    // The first question about this paper: summarize it before the judge runs.
    if (project) report = await summarizeFirst(project, report, { traceId: requestId, root, control, onStart: () => updateMessage(requestId, { stage: "paper" }) });
    const result = await runChatTurn(turn, {
      root,
      control,
      paper: () => paperOf(report),
      hooks: {
        onStage: (stage) => updateMessage(requestId, { stage }),
        onRefined: (refined) => updateMessage(requestId, { refined }),
        onText: (full) => updateMessage(requestId, { content: full }),
        onModel: (choice) => updateMessage(requestId, { provider: choice.provider, model: choice.model }),
      },
    });
    route = result.route;
    const content = result.content + (result.finishReason === "length" ? `\n\n${t("chat.truncated")}` : "");
    updateMessage(requestId, {
      content,
      status: "done",
      stage: undefined,
      route: result.outcome,
      edits: result.edits,
      editToolCallId: result.editToolCallId,
      provider: result.choice.provider,
      model: result.choice.model,
      fallbackFrom: result.fallbackFrom?.model,
      ...(result.finishReason === "length" ? { truncated: true } : {}),
    });
    step(requestId, root, "final", "showFinalAnswer", content, () => ({
      route: result.route,
      outcome: result.outcome,
      model: result.choice.model,
      fallback_from: result.fallbackFrom?.model ?? null,
      finishReason: result.finishReason,
      usage: result.usage,
      proposed_edits: result.edits?.length ?? 0,
      ui_mode: mode,
    }));
    endSpan(root, "pipeline", { status: "done", route: result.route, outcome: result.outcome });
  } catch (err) {
    const error = err instanceof AIError ? err : new AIError("unknown", String(err));
    if (error.kind === "cancelled") updateMessage(requestId, { status: "cancelled", stage: undefined });
    else updateMessage(requestId, { status: "error", stage: undefined, content: error.message });
    failSpan(root, "pipeline", error);
  } finally {
    if (running === control) running = null;
    if (useChat.getState().runningId === requestId) useChat.setState({ runningId: null });
    // Stopped and failed turns count too: they are turns left unanswered.
    if (useChat.getState().root === projectRoot && useChat.getState().sessionId === sessionId) {
      scheduleSummary({ traceId: requestId, root });
      // A turn that may have read the paper: summarize the sections edited since.
      if (route) scheduleSectionSummaries({ traceId: requestId, root });
    }
  }
}

export function stopChat() {
  const control = running;
  if (!control) return;
  control.stopped = true;
  if (control.activeRequest) void aiService.cancel(control.activeRequest);
}

// ---------------------------------------------------------------- session summary

/** The Session Summary Module run in the background, for one session at a time. */
let summarizing: { control: RunControl; again: boolean; done: Promise<void> } | null = null;
/** The turn that ended last; a summary run shows in its trace. */
let foldTrace: { traceId: string; root: Span } | null = null;

/**
 * Fold older turns into the session summary once ten are open or they run
 * long (see `./session/summarizer.ts`). It keeps folding while a long
 * session catches up, and stops when the user leaves the session. A failure
 * is tried again after the next turn; until then the modules read more turns
 * word for word.
 */
export function scheduleSummary(after?: { traceId: string; root: Span }) {
  if (after) foldTrace = after;
  if (summarizing) {
    summarizing.again = true;
    return;
  }
  const { sessionId } = useChat.getState();
  const control: RunControl = { stopped: false, activeRequest: null };
  const current = () => !control.stopped && useChat.getState().sessionId === sessionId;
  const run = async () => {
    while (current()) {
      const { messages, summary } = useChat.getState();
      const fold = turnsToFold(turnsOf(messages), summary);
      if (!fold.length) return;
      const { doc } = useProject.getState();
      const result = await foldTurns(summary, fold, {
        traceId: foldTrace?.traceId ?? newRequestId(),
        parent: foldTrace?.root ?? null,
        control,
        outline: doc?.flatSections.length ? outlineText(doc, 3000) : undefined,
      }).catch(() => null);
      if (!result || !current()) return;
      useChat.setState({ summary: result.summary });
    }
  };
  const job = { control, again: false, done: Promise.resolve() };
  job.done = run().finally(() => {
    if (summarizing !== job) return;
    summarizing = null;
    if (job.again && !control.stopped) scheduleSummary();
  });
  summarizing = job;
}

/** Stop folding for the session being left. */
function stopSummary() {
  const job = summarizing;
  if (!job) return;
  summarizing = null;
  job.control.stopped = true;
  if (job.control.activeRequest) void aiService.cancel(job.control.activeRequest);
}

/** Resolves once no summary (of the session or of sections) is being made (for tests). */
export async function summaryIdle(): Promise<void> {
  while (summarizing || sectioning) await (summarizing ?? sectioning)!.done;
}

// ---------------------------------------------------------------- section summaries

/** The Paper Summary Module run in the background, for one project at a time. */
let sectioning: { control: RunControl; again: boolean; done: Promise<void> } | null = null;
/** The turn that ended last; a section summary run shows in its trace. */
let sectionTrace: { traceId: string; root: Span } | null = null;

/**
 * Summarize the sections the paper summary has no summary for (see
 * `./paper/sectionSummarizer.ts`): sections edited since they were summarized,
 * or all of them when the first summary failed. It runs after a turn that
 * read the paper, and stops when another project opens.
 */
export function scheduleSectionSummaries(after?: { traceId: string; root: Span }) {
  if (after) sectionTrace = after;
  if (sectioning) {
    sectioning.again = true;
    return;
  }
  const project = useProject.getState().root;
  const trace = sectionTrace;
  if (!project || !trace) return;
  const control: RunControl = { stopped: false, activeRequest: null };
  const current = () => !control.stopped && useProject.getState().root === project;
  const run = async () => {
    const report = await loadReport(project);
    const { tex, doc } = paperNow();
    const { units } = paperUnits(doc, tex);
    const todo = unitsToSummarize(units, report);
    const sections = units.length;
    step(trace.traceId, trace.root, "sections", "checkSectionSummaries", () => ({ sections }), () => ({
      sections,
      summarized: sections - todo.length,
      to_summarize: todo.map((u) => u.key),
    }));
    if (!current()) return;
    if (!todo.length) {
      const next = withSummaries(report, [], units);
      if (Object.keys(next.summaries).length !== Object.keys(report.summaries).length) await saveReport(project, next, units, doc.title);
      return;
    }
    const result = await summarizeSections(todo, {
      traceId: trace.traceId,
      parent: trace.root,
      control,
      title: doc.title,
      outline: doc.flatSections.length ? outlineText(doc, 3000) : undefined,
    }).catch(() => null);
    if (!result?.summarized.length || !current()) return;
    await saveReport(project, withSummaries(await loadReport(project), result.summarized, units), units, doc.title);
  };
  const job = { control, again: false, done: Promise.resolve() };
  job.done = run()
    .catch(() => {
      // Tried again after the next turn; until then the sections are read word for word.
    })
    .finally(() => {
      if (sectioning !== job) return;
      sectioning = null;
      if (job.again && !control.stopped) scheduleSectionSummaries();
    });
  sectioning = job;
}

/** Stop summarizing sections of the project being left. */
function stopSectionSummaries() {
  const job = sectioning;
  if (!job) return;
  sectioning = null;
  job.control.stopped = true;
  if (job.control.activeRequest) void aiService.cancel(job.control.activeRequest);
}

// ---------------------------------------------------------------- saved sessions

/** Load the project's conversations and show the most recent one (or a new one). */
export async function openChatsFor(root: string | null): Promise<void> {
  stopChat();
  stopSummary();
  stopSectionSummaries();
  clearTimeout(saveTimer);
  useChat.setState({ root, mode: "auto", messages: [], summary: null, sessions: [], sessionId: newSessionId(), createdAt: Date.now() });
  if (!root) return;
  const sessions = await listSessions(root).catch(() => [] as SessionSummary[]);
  if (useChat.getState().root !== root) return;
  useChat.setState({ sessions });
  if (sessions[0]) await switchChatSession(sessions[0].id);
}

/** Start an empty conversation; it is saved once it has a message. */
export function newChatSession() {
  stopChat();
  stopSummary();
  flushSave();
  useChat.setState({ messages: [], summary: null, sessionId: newSessionId(), createdAt: Date.now() });
}

export async function switchChatSession(id: string): Promise<void> {
  const { root } = useChat.getState();
  if (!root) return;
  stopChat();
  stopSummary();
  flushSave();
  const file = await loadSession<ChatMessage>(root, id).catch(() => null);
  if (!file || useChat.getState().root !== root) return;
  const messages = file.messages.map((saved) => {
    // An answer that was still streaming when the app closed is shown as stopped.
    const message = saved.status === "streaming" ? { ...saved, status: "cancelled" as const, stage: undefined } : saved;
    if (!message.edits) return message;
    // Older proposals may have been generated from unopened CRLF files.
    // Keep them compatible with the LF source used by file reads and CodeMirror.
    return { ...message, edits: message.edits.map((edit) => ({
      ...edit,
      original: edit.original.replace(/\r\n?/g, "\n"),
      revised: edit.revised.replace(/\r\n?/g, "\n"),
    })) };
  });
  // A summary of more turns than the session has does not belong to it.
  const summary = readSummary(file.summary);
  const fits = summary && summary.coveredTurns <= turnsOf(messages).length ? summary : null;
  const mode = file.mode === "chat" || file.mode === "edit" ? file.mode : "auto";
  useChat.setState({ messages, mode, summary: fits, sessionId: id, createdAt: file.createdAt });
}

export async function deleteChatSession(id: string): Promise<void> {
  const { root, sessionId } = useChat.getState();
  if (!root) return;
  if (id === sessionId) {
    // Leave the conversation first so nothing saves it again while it is being removed.
    stopChat();
    stopSummary();
    clearTimeout(saveTimer);
    useChat.setState({ messages: [], summary: null, sessionId: newSessionId(), createdAt: Date.now() });
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
  const { root, sessionId, createdAt, messages, summary, runningId, sessions, mode } = useChat.getState();
  if (!root || messages.length === 0 || runningId) return;
  const updatedAt = Date.now();
  void saveSession(root, sessionId, { version: SESSION_VERSION, createdAt, updatedAt, mode, messages, ...(summary ? { summary } : {}) }).catch(() => {
    // Saving is best effort; the conversation stays usable in memory.
  });
  const entry: SessionSummary = { id: sessionId, title: sessionTitle(messages), createdAt, updatedAt, messageCount: messages.length };
  useChat.setState({ sessions: [entry, ...sessions.filter((s) => s.id !== sessionId)] });
}

// Save shortly after the conversation changes (new message, finished answer, applied edit, new summary).
useChat.subscribe((state, prev) => {
  if (state.root !== prev.root || state.sessionId !== prev.sessionId) setDebugProject(state.root, state.sessionId);
  if (state.messages === prev.messages && state.runningId === prev.runningId && state.summary === prev.summary && state.mode === prev.mode) return;
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
    messages: s.messages.map((m) => (m.id === messageId && !m.editStates?.[index] ? { ...m, editStates: { ...m.editStates, [index]: state } } : m)),
  }));
}

/** Only proposals actually saved on a completed Edit response may execute. */
function messageEdits(message: ChatMessage): ProposedEdit[] {
  if (message.status !== "done" || message.truncated || message.mode === "chat" || message.route === "chat") return [];
  if (message.mode) return message.route === "edit" && message.editToolCallId ? message.edits ?? [] : [];
  // Existing version 1/2 sessions used fenced edit blocks.
  return splitBlocks(message.content).flatMap((block) => {
    const edit = block.kind === "code" && block.lang === "edit" ? parseEditBody(block.meta ?? "", block.text) : null;
    return edit ? [edit] : [];
  });
}

/** Execute the accepted apply_paper_edits arguments in the current project. */
async function executePaperEditTool(messageId: string, entries: { index: number; edit: ProposedEdit }[]): Promise<{ path: string; line: number } | null> {
  const before = useChat.getState();
  const project = useProject.getState().root;
  const message = before.messages.find((m) => m.id === messageId);
  if (!project || before.root !== project || !message || !entries.length || new Set(entries.map((e) => e.index)).size !== entries.length) return null;
  const current = () => useChat.getState().root === project && useProject.getState().root === project && useChat.getState().sessionId === before.sessionId;
  const authorized = () => {
    const latest = useChat.getState().messages.find((m) => m.id === messageId);
    if (!latest) return false;
    const saved = messageEdits(latest);
    return entries.every(({ index, edit }) => {
      const original = saved[index];
      return !latest.editStates?.[index] && original && original.path === edit.path && original.original === edit.original && original.revised === edit.revised
        && original.lines?.from === edit.lines?.from && original.lines?.to === edit.lines?.to;
    });
  };
  if (!authorized()) return null;
  const span = startSpan(messageId, null, "edit", "apply_paper_edits", () => ({ call_id: message.editToolCallId ?? "legacy", edits: entries.map((e) => e.edit) }));
  try {
    const known = currentTexts();
    for (const { edit } of entries) {
      if (!validEditPath(edit.path) || !known.has(edit.path) || !current()) throw new Error(t("agent.failed"));
      if (!editorSession.has(edit.path) && !(await openFile(edit.path, { activate: false }))) throw new Error(t("agent.failed"));
    }
    if (!current() || !authorized()) {
      endSpan(span, "edit", { applied: 0, reason: "project, session or pending proposal changed" });
      return null;
    }
    // A file that is not UTF-8 stays read-only until it is converted; the proposal stays pending.
    const locked = entries.find(({ edit }) => editorSession.isReadOnly(edit.path));
    if (locked) {
      notify("error", t("project.lossyReadOnly", { path: locked.edit.path }));
      endSpan(span, "edit", { applied: 0, reason: "file is not UTF-8 (read-only)" });
      return null;
    }
    const texts = new Map(entries.map(({ edit }) => [edit.path, editorSession.textOf(edit.path) ?? ""]));
    const edits = entries.map(({ edit }) => {
      if (message.mode) return edit;
      const text = texts.get(edit.path)!;
      const at = locateEdit(text, edit.original);
      return at ? { ...edit, original: text.slice(at.from, at.to) } : edit;
    });
    const replacements = preparePaperEdits(edits, texts);
    step(messageId, span, "edit", "validatePaperEdits", { edits: entries.length }, { valid: !!replacements });
    if (!replacements) throw new Error(t("agent.failed"));
    const first = replacements[0];
    const location = { path: first.path, line: lineOf(texts.get(first.path)!, first.from) };
    // All files and anchors have passed validation. Offsets descend within each file.
    for (const edit of replacements) editorSession.applyEdit(edit.path, edit.from, edit.to, edit.revised);
    for (const { index } of entries) setEditState(messageId, index, "applied");
    endSpan(span, "edit", { applied: entries.length, files: [...new Set(replacements.map((e) => e.path))] });
    // Summarize actual source changes, including unsaved editor buffers.
    scheduleSectionSummaries({ traceId: messageId, root: span });
    return location;
  } catch (err) {
    failSpan(span, "edit", err);
    if (current()) for (const { index } of entries) setEditState(messageId, index, "failed");
    return null;
  }
}

export async function applyChatEdit(messageId: string, index: number, edit: ProposedEdit) {
  const done = await executePaperEditTool(messageId, [{ index, edit }]);
  if (done) await navigateTo(done.path, done.line);
}

export function rejectChatEdit(messageId: string, index: number) {
  setEditState(messageId, index, "rejected");
}

/** Preflight the entire pending batch before applying its replacements. */
export async function applyAllChatEdits(messageId: string, edits: { index: number; edit: ProposedEdit }[]) {
  const done = await executePaperEditTool(messageId, edits);
  notify(done ? "success" : "error", t(done ? "agent.appliedCount" : "agent.failedCount", { count: edits.length }));
}

export function rejectAllChatEdits(messageId: string, indexes: number[]) {
  for (const index of indexes) setEditState(messageId, index, "rejected");
}
