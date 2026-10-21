/**
 * The part of the prompt the Refine and Answer modules share.
 *
 * Both requests start with the same system prompt, the paper (L0), the
 * session summary (L1) and the recent turns (L2), so the provider's prompt
 * cache can reuse that prefix for the second call (and for the next question
 * while the paper is unchanged). Only the last message differs: the
 * question and the module's own task (L3).
 *
 * The paper is the whole paper file by file until the paper report has
 * summaries of it; then it is the paper section by section, the sections the
 * judge chose word for word and the others as their summaries.
 */
import type { AIRequest, PaperView } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { attr } from "./sectionSummary";
import { SESSION_RULES, summaryBlock } from "./session";
import { systemPrompt } from "./system";

const FILES_RULES = "<paper> holds the full source of the paper the user is writing, file by file; <omitted_files> lists files left out to fit the size limit.";

const SECTIONS_RULES = [
  '<paper> holds the paper the user is writing, section by section in reading order, each with its key. A section with content="full" is given word for word, in <source> blocks with the file and lines the text comes from. A section with content="summary" is only a summary of it, not its text. A section with content="omitted" was left out to fit the size limit. <macros> holds the macro definitions of the preamble.',
  "Quote, and propose edits to, only text you have word for word.",
].join("\n");

const PAPER_RULES = [
  "The last message holds the user's message and your task. Follow <task>.",
  SESSION_RULES,
  "Follow the user's preferences in <session_summary>.",
].join("\n");

function formatFiles(request: AIRequest): string {
  const files = (request.projectFiles ?? []).map((f) => `<file path="${f.path}">\n${f.text}\n</file>`);
  if (request.omittedFiles?.length) files.push(`<omitted_files>\n${request.omittedFiles.join("\n")}\n</omitted_files>`);
  return `<paper>\n${files.length ? files.join("\n") : "(no files)"}\n</paper>`;
}

function formatSections(view: PaperView): string {
  const blocks: string[] = [];
  if (view.macros) blocks.push(tag("macros", view.macros));
  for (const s of view.sections) {
    const head = `<section key="${attr(s.key)}" title="${attr(s.title)}" content="${s.content}">`;
    if (s.content === "full") {
      const sources = s.sources.map((r) => `<source file="${r.path}" lines="${r.fromLine}-${r.toLine}">\n${r.text}\n</source>`);
      blocks.push(`${head}\n${sources.join("\n")}\n</section>`);
    } else if (s.content === "summary") {
      blocks.push(`${head}\n${s.summary}\n</section>`);
    } else {
      blocks.push(`${head}</section>`);
    }
  }
  return `<paper>\n${blocks.join("\n")}\n</paper>`;
}

/** System prompt, paper and session summary, recent turns, then the module's last message. */
export function paperPrompt(request: AIRequest, last: string[]): PromptPayload {
  const history = (request.history ?? []).filter((m) => m.content.trim());
  // The conversation starts with a question; a leading answer has nothing to answer.
  while (history[0]?.role === "assistant") history.shift();
  const view = request.paperView;
  return {
    system: `${systemPrompt()}\n\n${view ? SECTIONS_RULES : FILES_RULES}\n${PAPER_RULES}`,
    messages: [
      { role: "user", content: [view ? formatSections(view) : formatFiles(request), summaryBlock(request)].filter(Boolean).join("\n\n") },
      ...history,
      { role: "user", content: last.filter(Boolean).join("\n\n") },
    ],
  };
}
