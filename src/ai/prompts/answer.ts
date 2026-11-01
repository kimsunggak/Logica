/**
 * Answer Module prompt: answer from the paper, with the question as
 * rewritten by the Refine Module when the Paper Orchestra refined it first.
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
  "You are the Paper Chat Module. Answer or discuss the user's message from the paper. Chat mode only discusses; manuscript changes are handled in Edit mode.",
  "<refined_question>, when present, is the user's message rewritten by an earlier step to be explicit. Use it to understand what to answer, and the user's own message for its exact wording.",
  "When you rely on a part of the paper, name the section by number and title so the author can find it.",
  "If the paper does not contain what the question needs, say so instead of guessing.",
  "Discuss possible improvements and show example wording as text when useful. Never output edit blocks or modification tool calls, and never claim to have changed files. Guide the user to Edit mode when they want manuscript changes applied.",
  "Keep \\label, \\ref and \\cite keys, math, environments and LaTeX commands intact unless the user asks to change them.",
  "Keep answers short and concrete unless the user's preferences say otherwise. Answer in the language the user writes in.",
];

const SECTIONS_RULE = 'Sections with content="summary" are summaries, not the paper\'s text: never quote them as the paper\'s words, and never write an edit block for a section you have only as a summary.';

/** With web search on: search only for what the paper lacks, and keep the two apart. */
const WEB_RULES = [
  "You can search the web. Search only when the question needs information the paper does not contain, such as related or recent work, outside facts or references; when the paper is enough, answer without searching. The rule above about saying the paper does not contain something applies to the paper itself, not to what you find on the web.",
  "Keep what the paper says apart from what you found on the web, and say which is which.",
  "Mention only sources that appear in your search results. Never invent papers, authors or \\cite keys.",
];

const ASK_SECTIONS_FIRST = "If you need the text of sections you have only as summaries, ask for them first, before searching the web.";

const ASK_RULE = `If the answer needs the text of sections you have only as summaries (to quote, edit or check exact details), reply with exactly ${NEED_SECTIONS} key, key]] and nothing else, with those sections' keys; you will then get them word for word.`;

export function buildAnswerPrompt(request: AIRequest): PromptPayload {
  const mayAsk = !!request.paperView && !!request.mayAskForSections;
  const web = request.webSearch ? [...WEB_RULES, ...(mayAsk ? [ASK_SECTIONS_FIRST] : [])] : [];
  const task = [...ANSWER_TASK, ...(request.paperView ? [SECTIONS_RULE] : []), ...(mayAsk ? [ASK_RULE] : []), ...web];
  const payload = paperPrompt(request, [
    tag("user_message", request.instruction),
    request.refinedQuestion ? tag("refined_question", request.refinedQuestion) : "",
    tag("task", task.join("\n")),
  ]);
  return { ...payload, system: `${payload.system}\n\n${[...ANSWER_TASK, ...(request.webSearch ? WEB_RULES : [])].join("\n")}` };
}
