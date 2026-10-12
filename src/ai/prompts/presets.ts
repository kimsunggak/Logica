/**
 * Inline edit commands offered in the Cmd/Ctrl+K box.
 */
export interface InlineCommand {
  id: string;
  label: string;
  instruction: string;
}

export const INLINE_COMMANDS: readonly InlineCommand[] = [
  {
    id: "improve",
    label: "Improve writing",
    instruction: "Improve the writing of the selected text: flow, word choice and readability, keeping the meaning and length roughly the same.",
  },
  {
    id: "concise",
    label: "Make concise",
    instruction: "Make the selected text more concise while preserving all technical meaning and LaTeX commands.",
  },
  {
    id: "academic",
    label: "Make academic",
    instruction: "Rewrite the selected text in a formal academic register suitable for a peer-reviewed paper, without changing its claims.",
  },
  {
    id: "clarity",
    label: "Improve clarity",
    instruction: "Improve the clarity and logical flow of the selected text. Make the argument easier to follow without changing what is claimed.",
  },
  {
    id: "grammar",
    label: "Fix grammar",
    instruction: "Fix grammar, spelling and punctuation in the selected text. Change as little as possible.",
  },
  {
    id: "rewrite",
    label: "Rewrite",
    instruction: "Rewrite the selected text with different phrasing while keeping the same meaning and level of detail.",
  },
];
