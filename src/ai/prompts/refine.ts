/**
 * Prompt refinement for questions about the paper: the sections chosen by the
 * selector, the restated question and the user's own words are assembled
 * into one focused prompt. Nothing outside those sections is sent.
 */
import type { AIMessage, AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { systemPrompt } from "./system";

const ANSWER_RULES = [
  "You answer questions about the current paper. Do not change it here.",
  "<selected_sections> were picked from the whole paper for this question; base the answer on them, and use <paper_outline> only to place them in the paper.",
  "When you rely on a section, name it by number and title so the author can find it.",
  "If the selected sections do not contain what the question needs, say which part of the paper would be needed instead of guessing.",
  "Do not write edit blocks or full rewrites. If the user seems to want a change, answer first and offer to make it.",
  "Keep answers short and concrete. Answer in the language the user writes in.",
].join("\n");

function formatSources(request: AIRequest): string {
  const sections = (request.sources ?? []).map((s) => `<section key="${s.key}" title="${s.label.replace(/"/g, "'")}">\n${s.text}\n</section>`);
  return sections.length ? `<selected_sections>\n${sections.join("\n")}\n</selected_sections>` : "";
}

export function buildAnswerPrompt(request: AIRequest): PromptPayload {
  const paper = [
    request.context.paperTitle ? tag("paper_title", request.context.paperTitle) : "",
    request.context.outline ? tag("paper_outline", request.context.outline) : "",
  ];
  const latest = [
    ...paper,
    formatSources(request),
    request.context.currentSection ? tag("cursor_section", request.context.currentSection) : "",
    request.selectedText ? tag("selected_text", request.selectedText) : "",
    request.focus ? tag("question_focus", request.focus) : "",
    tag("user_message", request.instruction),
  ]
    .filter(Boolean)
    .join("\n\n");

  const history: AIMessage[] = (request.history ?? []).filter((m) => m.content.trim());
  return {
    system: `${systemPrompt()}\n\n${ANSWER_RULES}`,
    messages: [...history, { role: "user", content: latest }],
  };
}
