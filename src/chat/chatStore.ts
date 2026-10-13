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
import type { AIMessage, ProviderId } from "../ai/types";
import { editorSession } from "../editor/editorSession";
import { sectionAt, sectionTrail } from "../latex/parser/documentModel";
import { currentTexts } from "../project/projectActions";
import { useProject } from "../project/projectStore";
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
}

interface ChatState {
  messages: ChatMessage[];
  /** Provider override for the chat; null means the default provider. */
  provider: ProviderId | null;
  runningId: string | null;
}

export const useChat = create<ChatState>()(() => ({ messages: [], provider: null, runningId: null }));

const MAX_HISTORY_MESSAGES = 12;

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

/** Split an assistant answer into text and fenced code blocks. */
export function splitBlocks(content: string): { kind: "text" | "code"; lang?: string; text: string }[] {
  const parts: { kind: "text" | "code"; lang?: string; text: string }[] = [];
  const fence = /```([a-zA-Z]*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (const m of content.matchAll(fence)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: content.slice(last, index) });
    parts.push({ kind: "code", lang: m[1] || undefined, text: m[2].replace(/\n$/, "") });
    last = index + m[0].length;
  }
  if (last < content.length) parts.push({ kind: "text", text: content.slice(last) });
  return parts.filter((p) => p.text.trim());
}
