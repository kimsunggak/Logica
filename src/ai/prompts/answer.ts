/**
 * Answer Agent prompt: the user's question, the intent worked out by the
 * Intent Module and the full source of the paper, in one request.
 */
import type { AIMessage, AIRequest } from "../types";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";
import { systemPrompt } from "./system";

const ANSWER_RULES = [
  "You are the Answer Agent of LOGICA. <paper> holds the full source of the paper the user is writing.",
  "<intent> is what the user wants, worked out before you by the Intent Module. Use it to understand the question, and the user's own message for its exact wording.",
  "Answer from the paper. When you rely on a part of it, name the section by number and title so the author can find it.",
  "If the paper does not contain what the question needs, say so instead of guessing.",
  "Only when the user asks for a change to the paper, propose every change as an edit block, one block per place:",
  "```edit <file path>",
  "<<<<<<< ORIGINAL",
  "<text copied exactly from that file>",
  "=======",
  "<replacement text>",
  ">>>>>>> REVISED",
  "```",
  "ORIGINAL must be copied character for character from the file, long enough to be unique in it and no longer than needed. REVISED replaces exactly that text, so repeat any unchanged part you keep. The author reviews each block as a diff; never claim a change is already applied.",
  "Keep \\label, \\ref and \\cite keys, math, environments and LaTeX commands intact unless the user asks to change them.",
  "Keep answers short and concrete. Answer in the language the user writes in.",
].join("\n");

function formatPaper(request: AIRequest): string {
  const files = (request.projectFiles ?? []).map((f) => `<file path="${f.path}">\n${f.text}\n</file>`);
  if (request.omittedFiles?.length) files.push(`<omitted_files>\n${request.omittedFiles.join("\n")}\n</omitted_files>`);
  return files.length ? `<paper>\n${files.join("\n")}\n</paper>` : "";
}

export function buildAnswerPrompt(request: AIRequest): PromptPayload {
  const location = formatContext(request.context, ["currentFile", "currentSection"]);
  const intent = request.intent ? `<intent type="${request.intent.type}">\n${request.intent.text}\n</intent>` : "";
  const latest = [
    formatPaper(request),
    location ? tag("editor_location", location) : "",
    request.selectedText
      ? tag("selected_text", request.selectedText)
      : request.context.currentParagraph
        ? tag("cursor_paragraph", request.context.currentParagraph)
        : "",
    intent,
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
