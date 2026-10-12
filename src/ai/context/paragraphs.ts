/**
 * Paragraph detection around a selection or cursor, used to give the AI the
 * text immediately before and after what is being edited.
 */

export interface TextRange {
  from: number;
  to: number;
}

export interface ParagraphContext {
  previous?: string;
  current?: string;
  next?: string;
  /** Range of the paragraph(s) covering the selection. */
  currentRange?: TextRange;
}

/**
 * Lines that are document structure rather than prose: headings, environment
 * boundaries, labels, includes and comment-only lines. They separate
 * paragraphs and never belong to one, so an AI edit of "the paragraph" cannot
 * rewrite a heading.
 */
const STRUCTURAL_LINE =
  /^\s*(?:%|\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]|\\(?:begin|end)\s*\{|\\(?:label|input|include|maketitle|bibliography|bibliographystyle|appendix|item\s*$)\b)/;

/** Paragraph blocks: runs of non-blank, non-structural lines. */
export function paragraphRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let start = -1;
  let end = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const isProse = line.trim() !== "" && !STRUCTURAL_LINE.test(line);
    if (isProse) {
      if (start < 0) start = offset;
      end = offset + line.length;
    } else if (start >= 0) {
      ranges.push({ from: start, to: end });
      start = -1;
    }
    offset += line.length + 1;
  }
  if (start >= 0) ranges.push({ from: start, to: end });
  return ranges;
}

function clip(text: string, maxChars: number, fromEnd: boolean): string {
  if (text.length <= maxChars) return text;
  return fromEnd ? `…${text.slice(text.length - maxChars)}` : `${text.slice(0, maxChars)}…`;
}

/**
 * Paragraphs before and after the selection `[from, to)`. With an empty
 * selection, `current` is the paragraph under the cursor.
 */
export function paragraphContext(text: string, from: number, to: number, maxChars = 1800): ParagraphContext {
  const ranges = paragraphRanges(text);
  if (ranges.length === 0) return {};
  let first = ranges.findIndex((r) => r.to >= from);
  if (first < 0) first = ranges.length - 1;
  let last = first;
  for (let i = first; i < ranges.length; i++) {
    if (ranges[i].from <= Math.max(from, to - 1)) last = i;
    else break;
  }
  // Cursor inside a blank gap: there is no current paragraph.
  const insideFirst = ranges[first].from <= Math.max(from, to - 1);
  const current = insideFirst ? { from: ranges[first].from, to: ranges[last].to } : undefined;
  const prevIndex = insideFirst ? first - 1 : first - 1;
  const nextIndex = insideFirst ? last + 1 : first;
  const slice = (r?: TextRange) => (r ? text.slice(r.from, r.to) : undefined);
  return {
    previous: prevIndex >= 0 ? clip(slice(ranges[prevIndex])!, maxChars, true) : undefined,
    current: current ? clip(slice(current)!, maxChars * 2, false) : undefined,
    next: nextIndex < ranges.length ? clip(slice(ranges[nextIndex])!, maxChars, false) : undefined,
    currentRange: current,
  };
}
