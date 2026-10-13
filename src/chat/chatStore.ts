/**
 * Context-aware chat about the current paper. Every message automatically
 * carries the project, file, section, surrounding paragraphs, selection,
 * abstract and outline, so the author never has to describe where they are.
 */
import { create } from "zustand";
import { buildChatContext } from "../ai/context/contextBuilder";
import { paragraphContext } from "../ai/context/paragraphs";
import { AIError } from "../ai/errors";
import { MAX_OUTPUT_TOKENS } from "../ai/models/modelConfig";
import { aiService, newRequestId } from "../ai/service";
import { lineOf, locateEdit, type ProposedEdit } from "../ai/agent/edits";
import type { AIMessage, ProjectFile, ProviderId } from "../ai/types";
import { editorSession } from "../editor/editorSession";
import { sectionAt, sectionTrail } from "../latex/parser/documentModel";
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
}

export type EditState = "applied" | "rejected" | "failed";

interface ChatState {
  messages: ChatMessage[];
  /** Provider override for the chat; null means the default provider. */
  provider: ProviderId | null;
  runningId: string | null;
}

export const useChat = create<ChatState>()(() => ({ messages: [], provider: null, runningId: null }));

const MAX_HISTORY_MESSAGES = 12;
/** Characters of paper source sent to the agent (roughly 40k tokens). */
const AGENT_FILE_BUDGET = 150_000;

/**
 * The paper's source files for the agent: the active file first, then the
 * files included from the main file, as long as they fit the budget.
 */
function agentFiles(activePath: string | undefined): { files: ProjectFile[]; omitted: string[] } {
  const { doc } = useProject.getState();
  const texts = currentTexts();
  const paths = (doc?.files ?? []).filter((f) => f.included && !f.missing).map((f) => f.path);
  if (activePath && texts.has(activePath)) paths.unshift(activePath);
  const files: ProjectFile[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const path of new Set(paths)) {
    const text = texts.get(path);
    if (text === undefined) continue;
    if (used + text.length > AGENT_FILE_BUDGET) {
      omitted.push(path);
      continue;
    }
    files.push({ path, text });
    used += text.length;
  }
  return { files, omitted };
}

export function chatProvider(): ProviderId {
  return useChat.getState().provider ?? useSettings.getState().ai.defaultProvider;
}

function updateMessage(id: string, patch: Partial<ChatMessage>) {
  useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
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
  let context = {};
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
  }

  const history: AIMessage[] = useChat
    .getState()
    .messages.filter((m) => m.status === "done" && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  const { files, omitted } = agentFiles(snapshot?.path);
  const requestId = newRequestId();
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
  };
  useChat.setState((s) => ({ messages: [...s.messages, userMessage, assistantMessage], runningId: requestId }));

  try {
    const response = await aiService.generate(
      provider,
      {
        id: requestId,
        task: "chat",
        instruction,
        selectedText: snapshot && snapshot.from !== snapshot.to ? snapshot.text : undefined,
        context,
        history,
        projectFiles: files,
        omittedFiles: omitted,
        model,
        maxOutputTokens: MAX_OUTPUT_TOKENS.chat,
      },
      { onDelta: (_d, full) => updateMessage(requestId, { content: full }) },
    );
    updateMessage(requestId, {
      content: response.text + (response.finishReason === "length" ? `\n\n${t("chat.truncated")}` : ""),
      status: "done",
    });
  } catch (err) {
    const error = err instanceof AIError ? err : new AIError("unknown", String(err));
    if (error.kind === "cancelled") updateMessage(requestId, { status: "cancelled" });
    else updateMessage(requestId, { status: "error", content: error.message });
  } finally {
    useChat.setState({ runningId: null });
  }
}

export function stopChat() {
  const { runningId } = useChat.getState();
  if (runningId) void aiService.cancel(runningId);
}

export function clearChat() {
  stopChat();
  useChat.setState({ messages: [] });
}

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
