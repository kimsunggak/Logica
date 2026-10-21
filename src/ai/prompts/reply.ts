/**
 * Reply Module prompt: answer small talk, or a message that is not about the
 * paper, from the message, the session summary and the recent turns. It does
 * not see the paper, so it does not answer questions about it.
 */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { conversationBlock, SESSION_RULES, summaryBlock } from "./session";

const REPLY_RULES = [
  "You are the Reply Module of LOGICA, a LaTeX writing tool for research papers. The message is small talk or not about the paper.",
  "Reply in one or two short, friendly sentences, in the language of the user's message.",
  "You cannot see the paper. If the message turns out to ask about the paper, say you can answer it when asked about the paper directly, without guessing its content.",
  "Follow the user's preferences in <session_summary>.",
].join("\n");

export function buildReplyPrompt(request: AIRequest): PromptPayload {
  const content = [summaryBlock(request), conversationBlock(request), tag("user_message", request.instruction), tag("task", "Reply to the user's message.")]
    .filter(Boolean)
    .join("\n\n");
  return { system: `${REPLY_RULES}\n\n${SESSION_RULES}`, messages: [{ role: "user", content }] };
}
