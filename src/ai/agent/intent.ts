/**
 * Read the Intent Module's JSON reply. A reply that cannot be read still
 * yields an intent (the reply text, or the question itself) so the Answer
 * Agent always runs.
 */
import type { IntentType, QuestionIntent } from "../types";

export const INTENT_TYPES: readonly IntentType[] = ["concept", "method", "result", "claim", "edit", "other"];

export function parseIntent(reply: string, question: string): QuestionIntent {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(reply.slice(start, end + 1)) as { type?: unknown; intent?: unknown };
      const type = INTENT_TYPES.includes(json.type as IntentType) ? (json.type as IntentType) : "other";
      const text = typeof json.intent === "string" ? json.intent.trim() : "";
      if (text) return { type, text };
    } catch {
      // Fall through to the plain-text fallback.
    }
  }
  return { type: "other", text: reply.trim() || question };
}
