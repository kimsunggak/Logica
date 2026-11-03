/** Refinement is plain text only; it has no routing or section-selection fields. */
export function parseRefine(reply: string, original: string): string {
  return reply.trim() || original;
}
