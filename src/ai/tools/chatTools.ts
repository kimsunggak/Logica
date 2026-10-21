/**
 * Tools the Chat Orchestrator's judge model calls, one per route. Each tool
 * is a module that makes one model call of its own; the judge never writes
 * text for the user and never sees the paper's text, only its map. With the
 * answer and refine routes it names the sections to read word for word.
 */
import type { ToolDefinition } from "../types";

export const REPLY_DIRECTLY = "reply_directly";
export const REFINE_QUESTION = "refine_question";
export const ANSWER_QUESTION = "answer_question";
/** The `sections` value that asks for the whole paper. */
export const ALL_SECTIONS = "all";

const REASON = (why: string) => ({ type: "string", description: `${why} One sentence, in the language of the user's message.` });

/** The reply route takes the reason for choosing it, shown in the runtime debugger. */
function reason(why: string): Record<string, unknown> {
  return { type: "object", properties: { reason: REASON(why) }, required: ["reason"], additionalProperties: false };
}

/** The paper routes also take the sections to read word for word. */
function paperRoute(why: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      reason: REASON(why),
      sections: {
        type: "array",
        items: { type: "string" },
        description: `Keys from <paper_map> of the sections to read word for word; the others are read as their summaries. ["${ALL_SECTIONS}"] for the whole paper. Empty when the summaries are enough, or when there is no map or no summary yet.`,
      },
    },
    required: ["reason", "sections"],
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
      "Answer a clear question, or carry out a clear edit request, about the paper, from the sections you list word for word and the rest as summaries. Edits are proposed for the author to review.",
    parameters: paperRoute("What the message points at and what it asks for, so that it can be answered as written without refining it first."),
  },
  {
    name: REFINE_QUESTION,
    description:
      "Rewrite an abstract, vague or broad message about the paper into one clear question, with the sections you list word for word and the rest as summaries, and then answer that question.",
    parameters: paperRoute("What is abstract, vague, broad or ambiguous about the message, so that it must be rewritten with the paper before answering."),
  },
];
