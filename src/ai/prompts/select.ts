/**
 * Prompt for the section selector: read the paper map and the question,
 * decide whether the user asks about the paper or wants it changed, and pick
 * the sections needed to answer.
 */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";

export const MAX_SELECTED_SECTIONS = 6;

const SELECT_RULES = [
  "You route questions inside LOGICA, a LaTeX writing tool for research papers. You never answer the question yourself.",
  "Read <paper_map>, the editor context and the user's message, then decide:",
  '1. intent: "edit" when the user wants the paper text changed (rewrite, shorten, fix, add, remove, unify, translate, restructure). "ask" for everything else: explanations, summaries, assessments, feedback or questions about the paper.',
  `2. sections: the keys from <paper_map> whose source is needed to answer, most relevant first, at most ${MAX_SELECTED_SECTIONS}. Pick the smallest set that is enough. When the message says "this" or "here", include the section at the cursor. For questions about the whole paper, pick the top-level sections that carry the argument.`,
  "3. focus: one sentence that restates exactly what the user wants answered, in the language of the user's message.",
  'Reply with JSON only, no prose and no code fence: {"intent":"ask","sections":["s2","s5"],"focus":"..."}',
].join("\n");

export function buildSelectPrompt(request: AIRequest): PromptPayload {
  const editor = [
    request.context.currentFile ? `current_file: ${request.context.currentFile}` : "",
    request.context.currentSection ? `cursor_section: ${request.context.currentSection}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const history = (request.history ?? [])
    .filter((m) => m.content.trim())
    .map((m) => `${m.role}: ${m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content}`)
    .join("\n");
  const content = [
    tag("paper_map", request.paperMap ?? ""),
    editor ? tag("editor_context", editor) : "",
    request.selectedText ? tag("selected_text", request.selectedText) : "",
    history ? tag("recent_conversation", history) : "",
    tag("user_message", request.instruction),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: SELECT_RULES, messages: [{ role: "user", content }] };
}
