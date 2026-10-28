/** Common preprocessing: resolve conversational references, preserving intent. */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { conversationBlock, SESSION_RULES, summaryBlock } from "./session";

export function buildRefinePrompt(request: AIRequest): PromptPayload {
  return {
    system: [
      "You are the Request Refinement Module of LOGICA.",
      "Rewrite the user's message as a self-contained request using the session summary and recent conversation to resolve omitted context and references.",
      "Preserve intent, question versus command, negation, uncertainty, conditions, and scope. A question evaluating a proposed change must stay a question; it is not an instruction to apply the change.",
      "Use only context established in the conversation. If a reference remains ambiguous, preserve that ambiguity rather than inventing a target or a desired action.",
      "Keep a message that is already explicit unchanged. Do not answer it, classify its intent, select paper sections, or ask a new question.",
      "Return only the rewritten request as plain text, in the user's language. No JSON, explanation, or code fence.",
      SESSION_RULES,
    ].join("\n"),
    messages: [{ role: "user", content: [summaryBlock(request), conversationBlock(request), tag("user_message", request.instruction)].filter(Boolean).join("\n\n") }],
  };
}
