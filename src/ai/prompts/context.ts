/**
 * Render the semantic AI context as tagged text blocks. Used by every task
 * so OpenAI and Claude receive the same context.
 */
import type { AIContext } from "../types";

type ContextKey = keyof AIContext;

const LABELS: Record<ContextKey, string> = {
  projectName: "project",
  currentFile: "current_file",
  paperTitle: "paper_title",
  abstract: "abstract",
  outline: "paper_outline",
  currentSection: "current_section",
  currentSectionText: "current_section_source",
  previousParagraph: "previous_paragraph",
  currentParagraph: "current_paragraph",
  nextParagraph: "next_paragraph",
};

export function tag(name: string, content: string): string {
  return `<${name}>\n${content.trim()}\n</${name}>`;
}

export function formatContext(context: AIContext, keys: ContextKey[]): string {
  const blocks: string[] = [];
  for (const key of keys) {
    const value = context[key];
    if (value && value.trim()) blocks.push(tag(LABELS[key], value));
  }
  return blocks.join("\n\n");
}
