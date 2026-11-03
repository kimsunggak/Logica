/**
 * Low-level LaTeX text utilities shared by the document parser, the BibTeX
 * parser, the AI context builder and the rewrite validator.
 */

/** Index of the first unescaped `%` in a line, or -1. */
export function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 37 /* % */) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * Replace comments with spaces. Offsets and line structure are preserved so
 * that positions found in the masked text are valid in the original text.
 */
export function maskComments(text: string): string {
  if (!text.includes("%")) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = commentStart(line);
    if (start >= 0) lines[i] = line.slice(0, start) + " ".repeat(line.length - start);
  }
  return lines.join("\n");
}

/** Offsets at which each line starts. `lineStarts[0] === 0`. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number of an offset. */
export function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let j = index - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 1;
}

export interface Group {
  /** Content between the delimiters. */
  content: string;
  /** Offset just after the closing delimiter. */
  end: number;
}

/**
 * Read a balanced group starting at `pos` (which must hold `open`).
 * Returns null for unbalanced (malformed) input.
 */
export function readGroup(
  text: string,
  pos: number,
  open = "{",
  close = "}",
  maxLength = 20000,
): Group | null {
  if (text[pos] !== open) return null;
  let depth = 0;
  const limit = Math.min(text.length, pos + maxLength);
  for (let i = pos; i < limit; i++) {
    const ch = text[i];
    if ((ch === "{" || ch === "}" || ch === open || ch === close) && isEscaped(text, i)) continue;
    if (open !== "{" && (ch === "{" || ch === "}")) {
      // Brackets inside braces do not count: skip nested brace groups.
      if (ch === "{") {
        const inner = readGroup(text, i, "{", "}", maxLength);
        if (!inner) return null;
        i = inner.end - 1;
      }
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { content: text.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

function skipSpaces(text: string, pos: number): number {
  let newlines = 0;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === "\n") {
      // A blank line ends the argument search (paragraph break).
      if (++newlines > 1) break;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r") break;
    pos++;
  }
  return pos;
}

export interface CommandMatch {
  name: string;
  starred: boolean;
  optional?: string;
  /** Required argument content (null when missing or malformed). */
  arg: string | null;
  /** Offset of the backslash. */
  start: number;
  /** Offset just after the parsed command (including arguments). */
  end: number;
}

/**
 * Find commands with one optional `[...]` argument and one required `{...}`
 * argument, e.g. `\section*[short]{Long title}`. Run on comment-masked text.
 */
export function findCommands(text: string, names: readonly string[]): CommandMatch[] {
  if (names.length === 0) return [];
  const pattern = new RegExp(`\\\\(${names.join("|")})(?![a-zA-Z@])(\\*?)`, "g");
  const matches: CommandMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (isEscaped(text, m.index)) continue;
    let pos = skipSpaces(text, m.index + m[0].length);
    let optional: string | undefined;
    if (text[pos] === "[") {
      const opt = readGroup(text, pos, "[", "]");
      if (opt) {
        optional = opt.content;
        pos = skipSpaces(text, opt.end);
      }
    }
    const group = readGroup(text, pos);
    matches.push({
      name: m[1],
      starred: m[2] === "*",
      optional,
      arg: group ? group.content : null,
      start: m.index,
      end: group ? group.end : pos,
    });
    if (group) pattern.lastIndex = Math.max(pattern.lastIndex, group.end);
  }
  return matches;
}

const DROP_WITH_ARG = /\\(?:label|thanks|footnote|footnotemark|index|cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|pageref)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g;

/** Convert a short LaTeX fragment (title, heading) into readable plain text. */
export function latexToPlain(input: string): string {
  let s = maskComments(input);
  s = s.replace(DROP_WITH_ARG, "");
  s = s.replace(/\\\\(\[[^\]]*\])?/g, " ");
  s = s.replace(/\\(?:&|%|\$|#|_|\{|\})/g, (m) => m.slice(1));
  s = s.replace(/~/g, " ");
  // Unwrap formatting commands: \emph{x} -> x
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1");
  }
  s = s.replace(/\\[a-zA-Z@]+\*?/g, " ");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/--/g, "–");
  return s.replace(/\s+/g, " ").trim();
}

const WORD_DROP = /\\(?:label|ref|eqref|autoref|cref|Cref|pageref|cite[a-zA-Z]*|includegraphics|input|include|bibliography|bibliographystyle|addbibresource|usepackage|documentclass|begin|end|url|href)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})?/g;

/** Approximate number of prose words in a (comment-masked) LaTeX line. */
export function countWords(line: string): number {
  if (!line.trim()) return 0;
  let s = line.replace(WORD_DROP, " ");
  s = s.replace(/\$[^$]*\$/g, " ");
  s = s.replace(/\\[a-zA-Z@]+\*?/g, " ");
  s = s.replace(/[{}[\]\\&~^_$]/g, " ");
  let count = 0;
  for (const token of s.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) count++;
  }
  return count;
}

/** Normalize a project-relative POSIX path (resolves `.` and `..`). */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else parts.push(part);
  }
  return parts.join("/");
}

export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

export function joinPath(dir: string, rel: string): string {
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}
