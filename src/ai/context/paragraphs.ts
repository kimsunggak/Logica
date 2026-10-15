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
 * boundaries, labels, includes, front matter (title, authors, date) and
 * package or macro definitions, and comment-only lines. They separate
 * paragraphs and never belong to one, so an AI edit of "the paragraph"
 * cannot rewrite a heading or the title.
 */
const STRUCTURAL_LINE =
  /^\s*(?:%|\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]|\\(?:begin|end)\s*\{|\\(?:label|input|include|maketitle|bibliography|bibliographystyle|appendix|item\s*$)\b|\\(?:title|titlerunning|author|authorrunning|date|thanks|keywords|affiliation|address|email|institute)\b|\\(?:documentclass|usepackage|RequirePackage|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|DeclareMathOperator|newtheorem|def)\b)/;

/** Everything before this line of a main file is the preamble. */
const DOCUMENT_BEGIN = /^\s*\\begin\s*\{document\}/;

/** Braces a line leaves open, ignoring escaped braces and comments. */
function openBraces(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "%") break;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

/**
 * Paragraph blocks: runs of non-blank, non-structural lines. The preamble
 * never holds prose, and the lines of a structural command whose argument
 * continues over several lines (a long `\author{...}`) are structural too,
 * up to the closing brace or a blank line.
 */
export function paragraphRanges(text: string): TextRange[] {
  const lines = text.split("\n");
  const bodyStart = lines.findIndex((line) => DOCUMENT_BEGIN.test(line));
  const ranges: TextRange[] = [];
  let start = -1;
  let end = 0;
  let offset = 0;
  let open = 0;
  lines.forEach((line, i) => {
    let structural = true;
    if (line.trim() === "") open = 0;
    else if (open > 0) open = Math.max(0, open + openBraces(line));
    else if (STRUCTURAL_LINE.test(line)) open = Math.max(0, openBraces(line));
    else structural = i < bodyStart;
    const isProse = line.trim() !== "" && !structural;
    if (isProse) {
      if (start < 0) start = offset;
      end = offset + line.length;
    } else if (start >= 0) {
      ranges.push({ from: start, to: end });
      start = -1;
    }
    offset += line.length + 1;
  });
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
