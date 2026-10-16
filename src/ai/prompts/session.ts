/**
 * How every chat module reads the conversation: the session summary (L1)
 * and the recent turns word for word (L2).
 */
import type { AIRequest } from "../types";
import { tag } from "./context";

export const SESSION_RULES = [
  "<session_summary>, when present, sums up the conversation before the recent turns: the user's goal, preferences (P#) to follow in every answer, requests that were not fully answered (U#), topics covered (T#) and material the user gave (R#).",
  "An earlier answer may end with [answer stopped by the user], [answer failed] or [answer cut off at the length limit]: that request was not fully answered. A long message may have its middle omitted, marked [... omitted ...].",
].join("\n");

export function summaryBlock(request: AIRequest): string {
  return request.sessionSummary ? tag("session_summary", request.sessionSummary) : "";
}

/** The recent turns as one block, for the modules that get a single message. */
export function conversationBlock(request: AIRequest): string {
  const lines = (request.history ?? []).filter((m) => m.content.trim()).map((m) => `${m.role}: ${m.content}`);
  return lines.length ? tag("recent_conversation", lines.join("\n")) : "";
}
