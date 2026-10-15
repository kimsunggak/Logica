/**
 * Refine Module prompt: rewrite an abstract message into one clear question
 * using the whole paper, or ask the user back when it cannot be settled.
 */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { editorBlocks, paperPrompt } from "./paper";

const REFINE_TASK = [
  "You are the Refine Module. Do not answer the user's message.",
  "Rewrite it as one clear, self-contained question or request about this paper, so that someone who sees only the paper and your rewrite knows exactly what to answer or change.",
  '- Resolve words such as "this", "that", "it" or "here" from the conversation and the open file.',
  "- Name the exact section, figure, table, equation, term or claim the message is about, using the paper.",
  "- Keep the user's intent and scope. Do not add requests the user did not make, and do not drop any they made.",
  "- Write in the language of the user's message.",
  "If the message has several plausible readings that the paper, the conversation and the editor location cannot settle, ask the user one short question instead.",
  'Reply with JSON only, no prose and no code fence: {"refined_question":"..."} or {"clarify":"..."}',
].join("\n");

export function buildRefinePrompt(request: AIRequest): PromptPayload {
  return paperPrompt(request, [...editorBlocks(request), tag("user_message", request.instruction), tag("task", REFINE_TASK)]);
}
