import {
  computeLineStarts,
  countWords,
  findCommands,
  latexToPlain,
  lineOfOffset,
  maskComments,
  readGroup,
} from "./text";

/** Heading commands and their outline level. */
export const HEADING_LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
};

export const REF_COMMANDS = ["ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref"];
export const CITE_COMMAND_PATTERN = "cite[a-zA-Z]*|[pP]arencite|[tT]extcite|footcite|autocite|nocite";

export interface HeadingFact {
  command: string;
  level: number;
  title: string;
  rawTitle: string;
  starred: boolean;
  line: number;
  offset: number;
}

export interface IncludeFact {
  command: "input" | "include";
  target: string;
  line: number;
  offset: number;
}

export interface LabelFact {
  key: string;
  line: number;
  offset: number;
}

export interface RefFact {
  key: string;
  command: string;
  line: number;
  offset: number;
}

export interface CiteFact {
  keys: string[];
  line: number;
}

export interface FileFacts {
  headings: HeadingFact[];
  includes: IncludeFact[];
  labels: LabelFact[];
  refs: RefFact[];
  cites: CiteFact[];
  title?: { raw: string; text: string; line: number };
  abstract?: { raw: string; line: number; endLine: number };
  bibResources: string[];
  hasDocumentClass: boolean;
  beginDocumentLine?: number;
  endDocumentLine?: number;
  /** Lines holding `\appendix`. */
  appendixLines: number[];
  lineCount: number;
  /** Prose word count per line (index 0 = line 1). */
  lineWords: Uint32Array;
}

function splitKeys(arg: string): string[] {
  return arg
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Extract the structural facts of a single LaTeX file. */
export function parseFile(text: string): FileFacts {
  const masked = maskComments(text);
  const lineStarts = computeLineStarts(masked);
  const line = (offset: number) => lineOfOffset(lineStarts, offset);

  const headings: HeadingFact[] = [];
  for (const m of findCommands(masked, Object.keys(HEADING_LEVELS))) {
    if (m.arg === null) continue;
    headings.push({
      command: m.name,
      level: HEADING_LEVELS[m.name],
      rawTitle: m.arg.trim(),
      title: latexToPlain(m.arg) || "(untitled)",
      starred: m.starred,
      line: line(m.start),
      offset: m.start,
    });
  }

  const includes: IncludeFact[] = [];
  for (const m of findCommands(masked, ["input", "include"])) {
    if (!m.arg) continue;
    const target = m.arg.trim();
    if (!target || target.includes("#")) continue; // macro parameters, not files
    includes.push({
      command: m.name as IncludeFact["command"],
      target,
      line: line(m.start),
      offset: m.start,
    });
  }

  const labels: LabelFact[] = [];
  for (const m of findCommands(masked, ["label"])) {
    if (!m.arg) continue;
    labels.push({ key: m.arg.trim(), line: line(m.start), offset: m.start });
  }

  const refs: RefFact[] = [];
  for (const m of findCommands(masked, REF_COMMANDS)) {
    if (!m.arg) continue;
    for (const key of splitKeys(m.arg)) {
      refs.push({ key, command: m.name, line: line(m.start), offset: m.start });
    }
  }

  const cites: CiteFact[] = [];
  const citePattern = new RegExp(`\\\\(?:${CITE_COMMAND_PATTERN})\\*?\\s*(?:\\[[^\\]]*\\]\\s*){0,2}\\{([^}]*)\\}`, "g");
  for (const m of masked.matchAll(citePattern)) {
    cites.push({ keys: splitKeys(m[1]), line: line(m.index ?? 0) });
  }

  let title: FileFacts["title"];
  const titleCmd = findCommands(masked, ["title"]).find((m) => m.arg !== null);
  if (titleCmd?.arg) {
    title = { raw: titleCmd.arg.trim(), text: latexToPlain(titleCmd.arg), line: line(titleCmd.start) };
  }

  let abstract: FileFacts["abstract"];
  const absBegin = /\\begin\s*\{abstract\}/.exec(masked);
  if (absBegin) {
    const contentStart = absBegin.index + absBegin[0].length;
    const absEnd = /\\end\s*\{abstract\}/g;
    absEnd.lastIndex = contentStart;
    const endMatch = absEnd.exec(masked);
    const contentEnd = endMatch ? endMatch.index : Math.min(masked.length, contentStart + 5000);
    abstract = {
      raw: masked.slice(contentStart, contentEnd).trim(),
      line: line(absBegin.index),
      endLine: line(contentEnd),
    };
  } else {
    const absCmd = findCommands(masked, ["abstract"]).find((m) => m.arg);
    if (absCmd?.arg) {
      abstract = { raw: absCmd.arg.trim(), line: line(absCmd.start), endLine: line(absCmd.end) };
    }
  }

  const bibResources: string[] = [];
  for (const m of findCommands(masked, ["bibliography", "addbibresource"])) {
    if (m.arg) bibResources.push(...splitKeys(m.arg));
  }

  const appendixLines: number[] = [];
  for (const m of masked.matchAll(/\\appendix(?![a-zA-Z@])/g)) appendixLines.push(line(m.index ?? 0));

  const beginDoc = /\\begin\s*\{document\}/.exec(masked);
  const endDoc = /\\end\s*\{document\}/.exec(masked);

  const rawLines = masked.split("\n");
  const lineWords = new Uint32Array(rawLines.length);
  const firstBodyLine = beginDoc ? line(beginDoc.index) + 1 : 1;
  for (let i = firstBodyLine - 1; i < rawLines.length; i++) lineWords[i] = countWords(rawLines[i]);

  return {
    headings,
    includes,
    labels,
    refs,
    cites,
    title,
    abstract,
    bibResources,
    hasDocumentClass: /\\documentclass(?![a-zA-Z@])/.test(masked),
    beginDocumentLine: beginDoc ? line(beginDoc.index) : undefined,
    endDocumentLine: endDoc ? line(endDoc.index) : undefined,
    appendixLines,
    lineCount: rawLines.length,
    lineWords,
  };
}

/** Find the label/ref/input key under a document offset, if any. */
export function keyAtOffset(
  text: string,
  offset: number,
): { command: string; key: string } | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEndIdx = text.indexOf("\n", offset);
  const lineText = text.slice(lineStart, lineEndIdx < 0 ? text.length : lineEndIdx);
  const col = offset - lineStart;
  const pattern = /\\([a-zA-Z]+)\*?(?:\[[^\]]*\])?\{/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(lineText))) {
    const braceAt = m.index + m[0].length - 1;
    const group = readGroup(lineText, braceAt);
    const end = group ? group.end : lineText.length;
    if (col < m.index || col > end) continue;
    const content = group ? group.content : lineText.slice(braceAt + 1);
    // Pick the comma-separated key under the cursor.
    let keyStart = braceAt + 1;
    for (const part of content.split(",")) {
      const keyEnd = keyStart + part.length;
      if (col <= keyEnd || part === content.split(",").at(-1)) {
        return { command: m[1], key: part.trim() };
      }
      keyStart = keyEnd + 1;
    }
  }
  return null;
}
