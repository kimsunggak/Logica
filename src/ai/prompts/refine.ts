/**
 * Refine Module prompt: rewrite an abstract message into one clear question
 * using the paper, or ask the user back when it cannot be settled. When the
 * paper comes section by section, it also settles which sections the answer
 * reads word for word.
 */
import type { AIRequest } from "../types";
import { ALL_SECTIONS } from "../tools/chatTools";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { editorBlocks, paperPrompt } from "./paper";

const REFINE_RULES = [
  "You are the Refine Module. Do not answer the user's message.",
  "Rewrite it as one clear, self-contained question or request about this paper, so that someone who sees only the paper and your rewrite knows exactly what to answer or change.",
  '- Resolve words such as "this", "that", "it" or "here" from the conversation and the open file.',
  "- Name the exact section, figure, table, equation, term or claim the message is about, using the paper.",
  "- Keep the user's intent and scope. Do not add requests the user did not make, and do not drop any they made.",
  "- Write in the language of the user's message.",
  "If the message has several plausible readings that the paper, the conversation and the editor location cannot settle, ask the user one short question instead.",
];

const FILES_TASK = [...REFINE_RULES, 'Reply with JSON only, no prose and no code fence: {"refined_question":"..."} or {"clarify":"..."}'].join("\n");

const SECTIONS_TASK = [
  ...REFINE_RULES,
  `In sections, list the keys of the sections the answer must read word for word, now that the question is clear: the parts it is about, every section an edit would change, and sections whose exact wording, numbers, equations or tables the answer needs. The others are given as their summaries. Use ["${ALL_SECTIONS}"] when the answer needs the whole paper.`,
  'Reply with JSON only, no prose and no code fence: {"refined_question":"...","sections":["..."]} or {"clarify":"..."}',
].join("\n");

export function buildRefinePrompt(request: AIRequest): PromptPayload {
  const task = request.paperView ? SECTIONS_TASK : FILES_TASK;
  return paperPrompt(request, [...editorBlocks(request), tag("user_message", request.instruction), tag("task", task)]);
}
