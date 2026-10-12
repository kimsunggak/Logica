/**
 * Prompt for the context-aware chat panel.
 */
import type { AIMessage, AIRequest } from "../types";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";
import { systemPrompt } from "./system";

const CHAT_RULES = [
  "You are the chat assistant of LOGICA. Help with editing the current paper only; politely decline unrelated tasks.",
  "The context below is gathered automatically from the editor, so the user does not need to describe where they are.",
  "When you propose replacement text for the selection (or the current paragraph if nothing is selected), put the exact LaTeX in a single ```latex fenced block so the author can review it as a diff before applying. The block must contain only the replacement for that text.",
  "Keep answers short and concrete. Answer in the language the user writes in.",
].join("\n");

export function buildChatPrompt(request: AIRequest): PromptPayload {
  const context = formatContext(request.context, [
    "projectName",
    "currentFile",
    "paperTitle",
    "abstract",
    "outline",
    "currentSection",
    "currentSectionText",
    "previousParagraph",
    "currentParagraph",
    "nextParagraph",
  ]);
  const latest = [
    context ? tag("editor_context", context) : "",
    request.selectedText ? tag("selected_text", request.selectedText) : "",
    tag("user_message", request.instruction),
  ]
    .filter(Boolean)
    .join("\n\n");

  const history: AIMessage[] = (request.history ?? []).filter((m) => m.content.trim());
  return {
    system: `${systemPrompt()}\n\n${CHAT_RULES}`,
    messages: [...history, { role: "user", content: latest }],
  };
}
