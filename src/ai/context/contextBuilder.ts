/**
 * Context builder: turns the editor state and the paper model into the
 * provider-independent `AIContext`. Only what the current edit needs is
 * included; the full paper is never sent.
 */
import {
  outlineText,
  sectionAt,
  sectionTrail,
  type PaperDocument,
} from "../../latex/parser/documentModel";
import type { AIContext } from "../types";
import { paragraphContext } from "./paragraphs";

export interface EditorSnapshot {
  projectName?: string;
  filePath: string;
  /** Full text of the current file (including unsaved changes). */
  text: string;
  selectionFrom: number;
  selectionTo: number;
}

const LIMITS = {
  abstract: 2500,
  outline: 3000,
  paragraph: 1800,
};

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function paperContext(doc: PaperDocument | null, snap: EditorSnapshot): AIContext {
  if (!doc) return {};
  const line = lineAt(snap.text, snap.selectionFrom);
  const section = sectionAt(doc, snap.filePath, line);
  return {
    paperTitle: doc.title,
    abstract: clip(doc.abstract, LIMITS.abstract),
    outline: doc.flatSections.length ? outlineText(doc, LIMITS.outline) : undefined,
    currentSection: section
      ? section.order >= 0
        ? sectionTrail(doc, section)
        : section.title
      : undefined,
  };
}

/** Context for an inline edit of the current selection. */
export function buildEditContext(doc: PaperDocument | null, snap: EditorSnapshot): AIContext {
  const paragraphs = paragraphContext(snap.text, snap.selectionFrom, snap.selectionTo, LIMITS.paragraph);
  return {
    ...paperContext(doc, snap),
    previousParagraph: paragraphs.previous,
    nextParagraph: paragraphs.next,
  };
}
