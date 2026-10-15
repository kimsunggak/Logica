/**
 * Read the Refine Module's JSON reply: a refined question, or a question to
 * ask the user back. A reply that cannot be read still yields a question
 * (the reply text, or the user's own message) so the answer step can run.
 */
export type RefineResult = { kind: "refined"; text: string } | { kind: "clarify"; text: string };

export function parseRefine(reply: string, question: string): RefineResult {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(reply.slice(start, end + 1)) as { refined_question?: unknown; clarify?: unknown };
      const refined = typeof json.refined_question === "string" ? json.refined_question.trim() : "";
      const clarify = typeof json.clarify === "string" ? json.clarify.trim() : "";
      if (refined) return { kind: "refined", text: refined };
      if (clarify) return { kind: "clarify", text: clarify };
    } catch {
      // Fall through to the plain-text fallback.
    }
  }
  const text = reply.trim();
  return { kind: "refined", text: text && !text.includes("{") ? text : question };
}
