/**
 * Tools the Chat Orchestrator's judge model calls, one per route. Each tool
 * is a module that makes one model call of its own; the judge never writes
 * text for the user and never sees the paper.
 */
import type { ToolDefinition } from "../types";

export const REPLY_DIRECTLY = "reply_directly";
export const REFINE_QUESTION = "refine_question";
export const ANSWER_QUESTION = "answer_question";

/** Every tool takes the reason for choosing this route, shown in the runtime debugger. */
function reason(why: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { reason: { type: "string", description: `${why} One sentence, in the language of the user's message.` } },
    required: ["reason"],
    additionalProperties: false,
  };
}

export const CHAT_TOOLS: ToolDefinition[] = [
  {
    name: REPLY_DIRECTLY,
    description: "Let the Reply Module answer small talk, thanks, a greeting, or a message that is not about the paper or writing it. It does not read the paper.",
    parameters: reason("Why the message is not a question or request about the paper."),
  },
  {
    name: ANSWER_QUESTION,
    description:
      "Answer a clear question, or carry out a clear edit request, about the paper from the whole paper. Edits are proposed for the author to review.",
    parameters: reason("What the message points at and what it asks for, so that it can be answered as written without refining it first."),
  },
  {
    name: REFINE_QUESTION,
    description:
      "Rewrite an abstract, vague or broad message about the paper into one clear question, using the whole paper, and then answer that question.",
    parameters: reason("What is abstract, vague, broad or ambiguous about the message, so that it must be rewritten with the paper before answering."),
  },
];
