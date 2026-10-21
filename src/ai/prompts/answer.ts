/**
 * Answer Module prompt: answer from the paper, with the question as
 * rewritten by the Refine Module when the Chat Orchestrator refined it first.
 * When the paper comes section by section and a section it needs is only a
 * summary, the first answer may ask for it instead (`[[need_sections: ...]]`).
 */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { paperPrompt } from "./paper";

/** How the answer asks for sections it has only as summaries. */
export const NEED_SECTIONS = "[[need_sections:";

const ANSWER_TASK = [
  "You are the Answer Module. Answer the user's message from the paper.",
  "<refined_question>, when present, is the user's message rewritten by an earlier step to be explicit. Use it to understand what to answer, and the user's own message for its exact wording.",
  "When you rely on a part of the paper, name the section by number and title so the author can find it.",
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
  "When <session_summary> lists requests that were not fully answered (U#): handle one together with the user's message when it is related; otherwise end with one short line offering to continue it.",
  "Keep answers short and concrete unless the user's preferences say otherwise. Answer in the language the user writes in.",
];

const SECTIONS_RULE = 'Sections with content="summary" are summaries, not the paper\'s text: never quote them as the paper\'s words, and never write an edit block for a section you have only as a summary.';

const ASK_RULE = `If the answer needs the text of sections you have only as summaries (to quote, edit or check exact details), reply with exactly ${NEED_SECTIONS} key, key]] and nothing else, with those sections' keys; you will then get them word for word.`;

export function buildAnswerPrompt(request: AIRequest): PromptPayload {
  const task = [...ANSWER_TASK, ...(request.paperView ? [SECTIONS_RULE] : []), ...(request.paperView && request.mayAskForSections ? [ASK_RULE] : [])];
  return paperPrompt(request, [
    tag("user_message", request.instruction),
    request.refinedQuestion ? tag("refined_question", request.refinedQuestion) : "",
    tag("task", task.join("\n")),
  ]);
}
