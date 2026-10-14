/**
 * Intent Module prompt: work out what the user wants to know before the
 * paper is read. It answers nothing itself.
 */
import type { AIRequest } from "../types";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";

const INTENT_RULES = [
  "You are the Intent Module of LOGICA, a LaTeX writing tool for research papers. You do not answer the question.",
  "Work out what the user wants to know (or get) from their message, using the editor location, the selected text and the recent conversation to resolve words such as \"this\", \"that\" or \"it\".",
  "type is one of:",
  "- concept: explain a concept or term used in the paper",
  "- method: understand how a method, model or procedure in the paper works",
  "- result: interpret experimental results, tables or figures",
  "- claim: check whether the paper states, supports or proves a claim",
  "- edit: change the paper text",
  "- other: anything else",
  "intent: one or two sentences, in the language of the user's message, stating exactly what the user wants. Name the concept, method, result or claim, and the part of the paper it concerns when the message or the editor location shows it. Do not add requests the user did not make.",
  'Reply with JSON only, no prose and no code fence: {"type":"method","intent":"..."}',
].join("\n");

const CLIP = { text: 1500, turn: 600 };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildIntentPrompt(request: AIRequest): PromptPayload {
  const paper = formatContext(request.context, ["paperTitle", "outline"]);
  const location = formatContext(request.context, ["currentFile", "currentSection"]);
  const history = (request.history ?? [])
    .filter((m) => m.content.trim())
    .map((m) => `${m.role}: ${clip(m.content, CLIP.turn)}`)
    .join("\n");
  const content = [
    paper,
    location ? tag("editor_location", location) : "",
    request.selectedText
      ? tag("selected_text", clip(request.selectedText, CLIP.text))
      : request.context.currentParagraph
        ? tag("cursor_paragraph", clip(request.context.currentParagraph, CLIP.text))
        : "",
    history ? tag("recent_conversation", history) : "",
    tag("user_message", request.instruction),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: INTENT_RULES, messages: [{ role: "user", content }] };
}
