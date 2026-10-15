/**
 * The part of the prompt the Refine and Answer modules share.
 *
 * Both requests start with the same system prompt, the paper and the
 * conversation, so the provider's prompt cache can reuse that prefix for the
 * second call (and for the next question while the paper is unchanged). Only
 * the last message differs: the editor location, the question and the
 * module's own task, placed after the paper.
 */
import type { AIRequest } from "../types";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";
import { systemPrompt } from "./system";

const PAPER_RULES = [
  "<paper> holds the full source of the paper the user is writing, file by file; <omitted_files> lists files left out to fit the size limit.",
  "The last message holds the user's location in the editor, their message and your task. Follow <task>.",
].join("\n");

function formatPaper(request: AIRequest): string {
  const files = (request.projectFiles ?? []).map((f) => `<file path="${f.path}">\n${f.text}\n</file>`);
  if (request.omittedFiles?.length) files.push(`<omitted_files>\n${request.omittedFiles.join("\n")}\n</omitted_files>`);
  return `<paper>\n${files.length ? files.join("\n") : "(no files)"}\n</paper>`;
}

/**
 * Where the user is: the open file. The selection and the cursor's paragraph
 * and section are left out, since they often stay where the user last
 * worked, unrelated to the question.
 */
export function editorBlocks(request: AIRequest): string[] {
  const location = formatContext(request.context, ["currentFile"]);
  return [location ? tag("editor_location", location) : ""];
}

/** System prompt, paper, conversation, then the module's last message. */
export function paperPrompt(request: AIRequest, last: string[]): PromptPayload {
  const history = (request.history ?? []).filter((m) => m.content.trim());
  // The conversation starts with a question; a leading answer has nothing to answer.
  while (history[0]?.role === "assistant") history.shift();
  return {
    system: `${systemPrompt()}\n\n${PAPER_RULES}`,
    messages: [
      { role: "user", content: formatPaper(request) },
      ...history,
      { role: "user", content: last.filter(Boolean).join("\n\n") },
    ],
  };
}
