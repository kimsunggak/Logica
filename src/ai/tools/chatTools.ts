/**
 * Tools the Chat Orchestrator's judge model can call. Each tool is a module
 * that makes one model call of its own; the judge never sees the paper.
 */
import type { ToolDefinition } from "../types";

export const REFINE_QUESTION = "refine_question";
export const ANSWER_QUESTION = "answer_question";

/** Both tools take a one-line reason, shown in the runtime debugger. */
const REASON: Record<string, unknown> = {
  type: "object",
  properties: { reason: { type: "string", description: "One short sentence on why you chose this tool." } },
  required: ["reason"],
  additionalProperties: false,
};

export const CHAT_TOOLS: ToolDefinition[] = [
  {
    name: REFINE_QUESTION,
    description:
      "Rewrite an abstract, vague or broad message about the paper into one clear question, using the whole paper, and then answer that question.",
    parameters: REASON,
  },
  {
    name: ANSWER_QUESTION,
    description:
      "Answer a clear question, or carry out a clear edit request, about the paper from the whole paper. Edits are proposed for the author to review.",
    parameters: REASON,
  },
];
