/**
 * Prompt for inline edits of a selection (Cmd/Ctrl+K).
 */
import type { AIRequest } from "../types";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";
import { systemPrompt } from "./system";

const OUTPUT_RULES = [
  "Return only the revised LaTeX that replaces <selected_text>.",
  "Do not wrap it in code fences or quotes. Do not add explanations, notes or headings.",
  "Do not repeat the previous or next paragraph.",
  "Write in the same language as the selected text.",
].join("\n");

export function buildInlineEditPrompt(request: AIRequest): PromptPayload {
  const context = formatContext(request.context, [
    "paperTitle",
    "abstract",
    "outline",
    "currentSection",
    "previousParagraph",
  ]);
  const after = formatContext(request.context, ["nextParagraph"]);
  const user = [
    "You are editing an academic research paper written in LaTeX.",
    context,
    tag("selected_text", request.selectedText ?? ""),
    after,
    tag("instruction", request.instruction),
    OUTPUT_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: systemPrompt(), messages: [{ role: "user", content: user }] };
}
