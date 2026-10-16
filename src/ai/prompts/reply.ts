/**
 * Reply Module prompt: answer small talk, or a message that is not about the
 * paper, from the message and the recent conversation. It does not see the
 * paper, so it does not answer questions about it.
 */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { JUDGE_HISTORY_MESSAGES } from "./judge";

const REPLY_RULES = [
  "You are the Reply Module of LOGICA, a LaTeX writing tool for research papers. The message is small talk or not about the paper.",
  "Reply in one or two short, friendly sentences, in the language of the user's message.",
  "You cannot see the paper. If the message turns out to ask about the paper, say you can answer it when asked about the paper directly, without guessing its content.",
].join("\n");

const CLIP_TURN = 600;

export function buildReplyPrompt(request: AIRequest): PromptPayload {
  const history = (request.history ?? [])
    .slice(-JUDGE_HISTORY_MESSAGES)
    .filter((m) => m.content.trim())
    .map((m) => `${m.role}: ${m.content.length > CLIP_TURN ? `${m.content.slice(0, CLIP_TURN)}…` : m.content}`)
    .join("\n");
  const content = [history ? tag("recent_conversation", history) : "", tag("user_message", request.instruction), tag("task", "Reply to the user's message.")]
    .filter(Boolean)
    .join("\n\n");
  return { system: REPLY_RULES, messages: [{ role: "user", content }] };
}
