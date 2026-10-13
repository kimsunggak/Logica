/**
 * Prompt for the context-aware chat panel.
 */
import type { AIMessage, AIRequest } from "../types";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";
import { systemPrompt } from "./system";

const CHAT_RULES = [
  "You are the editing agent of LOGICA. Help with the current paper only; politely decline unrelated tasks.",
  "The context below is gathered automatically from the editor, so the user does not need to describe where they are. Requests about \"this\" refer to the selection, or to the current paragraph when nothing is selected.",
  "You can change any file shown in <project_files>, in as many places as the request needs (for example unifying terminology across sections).",
  "Propose every change as an edit block, one block per place:",
  "```edit <file path>",
  "<<<<<<< ORIGINAL",
  "<text copied exactly from that file>",
  "=======",
  "<replacement text>",
  ">>>>>>> REVISED",
  "```",
  "ORIGINAL must be copied character for character from the file, long enough to be unique in it and no longer than needed. REVISED replaces exactly that text, so repeat any unchanged part you keep.",
  "Keep \\label, \\ref and \\cite keys, math, environments and LaTeX commands intact unless the user asks to change them.",
  "Before the blocks, say briefly what you change and why. The author reviews each block as a diff and decides; never claim a change is already applied.",
  "If no change is needed, answer without edit blocks. Keep answers short and concrete. Answer in the language the user writes in.",
].join("\n");

function formatFiles(request: AIRequest): string {
  const files = (request.projectFiles ?? []).map((f) => `<file path="${f.path}">\n${f.text}\n</file>`);
  if (request.omittedFiles?.length) files.push(`<omitted_files>\n${request.omittedFiles.join("\n")}\n</omitted_files>`);
  return files.length ? `<project_files>\n${files.join("\n")}\n</project_files>` : "";
}

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
    formatFiles(request),
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
