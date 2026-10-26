/**
 * The paper as section units (L0): what source selection picks from and what the
 * Chat and Edit modules read, each unit word for word or as its summary.
 *
 *   metadata  title/author declarations, described directly without an LLM
 *   abstract  body front matter and abstract, read word for word in every turn
 *   3, 3.2    each section and subsection: its own text, without its subsections
 *
 * Deeper headings stay in their subsection. A unit's hash is the key of its
 * summary in the paper summary (`./report.ts`), so a summary survives
 * renumbering and only an edited unit is summarized again.
 */
import { giOf, type PaperDocument } from "../../latex/parser/documentModel";
import { countWords, maskComments } from "../../latex/parser/text";
import type { SourceRange } from "../../ai/types";
import { METADATA, paperMetadata } from "./metadata";

/** The body front matter, including maketitle and the abstract. */
export const FRONT = "abstract";

export interface SectionUnit {
  /** The section number ("3.2"), `metadata`, `abstract`, or "u1" for an unnumbered heading. */
  key: string;
  title: string;
  /** 0 for the front matter and top-level sections, 1 for subsections. */
  depth: number;
  /** The section a subsection belongs to. */
  parentKey?: string;
  /** The unit's own text in reading order, one range per file it runs through. */
  sources: SourceRange[];
  /** Hash of the unit's text: the key of its summary. */
  hash: string;
  chars: number;
  words: number;
  /** Prose words after its heading line: 0 when the section has no text of its own yet. */
  bodyWords: number;
  /** `\label` keys defined in it. */
  labels: string[];
  /** Metadata is extracted directly and never sent to a summary model. */
  summary?: string;
}

export interface PaperUnits {
  units: SectionUnit[];
  /** Macro definitions of the preamble (`\newcommand`, `\def`, ...). */
  macros: string;
}

const MACRO_CHARS = 3_000;
const MACRO = /^\s*\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|def|let|(?:re)?newenvironment|newtheorem)\b/;

/** A short, stable hash of a text (53-bit cyrb53, in hex). */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The text of a unit, as it is hashed and sent. */
export function unitText(unit: Pick<SectionUnit, "sources">): string {
  return unit.sources.map((s) => s.text).join("\n");
}

function braceDepth(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "{") depth++;
    else if (line[i] === "}") depth--;
  }
  return depth;
}

/** Macro definitions in a preamble, each with the lines it continues on. */
export function macrosOf(preamble: string): string {
  const lines = maskComments(preamble).split("\n");
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!MACRO.test(lines[i])) continue;
    let end = i;
    let depth = braceDepth(lines[i]);
    while (depth > 0 && end + 1 < lines.length && end - i < 8) depth += braceDepth(lines[++end]);
    const definition = lines.slice(i, end + 1).map((l) => l.trimEnd()).join("\n");
    i = end;
    if (size + definition.length > MACRO_CHARS) break;
    out.push(definition);
    size += definition.length + 1;
  }
  return out.join("\n");
}

/**
 * Split the paper into section units. Units cover the body from
 * `\begin{document}` to `\end{document}`. Title/author declarations form a
 * separate metadata unit; the preamble also supplies macro definitions.
 */
export function paperUnits(doc: PaperDocument, files: Map<string, string>): PaperUnits {
  const main = doc.mainFile;
  const facts = main ? doc.facts.get(main) : undefined;
  if (!main || !facts || doc.totalLines === 0) return { units: [], macros: "" };

  const fileLines = new Map<string, string[]>();
  const linesOf = (path: string) => {
    let lines = fileLines.get(path);
    if (!lines) fileLines.set(path, (lines = (files.get(path) ?? "").split("\n")));
    return lines;
  };
  // Reading-order lines from..to, as one range per run of a file.
  const read = (from: number, to: number): SourceRange[] => {
    const ranges: { path: string; fromLine: number; toLine: number }[] = [];
    for (const span of doc.spans) {
      const a = Math.max(from, span.giStart);
      const b = Math.min(to, span.giStart + span.toLine - span.fromLine);
      if (a > b) continue;
      const fromLine = span.fromLine + (a - span.giStart);
      const toLine = span.fromLine + (b - span.giStart);
      const prev = ranges.at(-1);
      if (prev && prev.path === span.filePath && prev.toLine + 1 === fromLine) prev.toLine = toLine;
      else ranges.push({ path: span.filePath, fromLine, toLine });
    }
    return ranges.map((r) => ({ ...r, text: linesOf(r.path).slice(r.fromLine - 1, r.toLine).join("\n") }));
  };

  const begin = facts.beginDocumentLine ? giOf(doc, main, facts.beginDocumentLine) : -1;
  const end = facts.endDocumentLine ? giOf(doc, main, facts.endDocumentLine) : -1;
  const last = end > 0 ? end - 1 : doc.totalLines - 1;
  const levels = doc.flatSections.map((s) => s.level).filter((level) => level >= 0);
  const top = levels.length ? Math.min(...levels) : 0;
  const headings = doc.flatSections.filter((s) => s.level <= top + 1 && s.startGi > begin && s.startGi <= last);
  const labelGis = doc.labels.map((l) => ({ key: l.key, gi: giOf(doc, l.filePath, l.line) }));

  const units: SectionUnit[] = [];
  const metadata = paperMetadata(doc, files);
  if (metadata) {
    const text = unitText(metadata);
    units.push({ key: METADATA, title: "Title and Authors", depth: 0, sources: metadata.sources, summary: metadata.summary,
      hash: textHash(text), chars: text.length, words: countWords(text), bodyWords: 0, labels: [] });
  }
  const used = new Set<string>();
  const unique = (key: string) => {
    let name = key;
    for (let n = 2; used.has(name); n++) name = `${key}~${n}`;
    used.add(name);
    return name;
  };
  const wordsOf = (text: string) => maskComments(text).split("\n").reduce((n, line) => n + countWords(line), 0);
  const add = (key: string, title: string, depth: number, parentKey: string | undefined, from: number, to: number) => {
    if (to < from) return;
    const sources = read(from, to);
    const text = unitText({ sources });
    if (!text.trim()) return;
    const body = key === FRONT ? text : text.slice(text.indexOf("\n") + 1 || text.length);
    units.push({
      key: unique(key),
      title,
      depth,
      ...(parentKey ? { parentKey } : {}),
      sources,
      hash: textHash(text),
      chars: text.length,
      words: wordsOf(text),
      bodyWords: wordsOf(body),
      labels: labelGis.filter((l) => l.gi >= from && l.gi <= to).map((l) => l.key),
    });
  };

  add(FRONT, "Abstract", 0, undefined, begin + 1, (headings[0]?.startGi ?? last + 1) - 1);
  const keys = new Map<string, string>();
  let unnumbered = 0;
  headings.forEach((s, i) => {
    const depth = s.level <= top ? 0 : 1;
    const next = headings[i + 1]?.startGi ?? last + 1;
    const before = units.length;
    add(s.number ?? `u${++unnumbered}`, s.title, depth, depth ? keys.get(s.parentId ?? "") : undefined, s.startGi, Math.min(s.endGi, next - 1));
    if (units.length > before) keys.set(s.id, units[units.length - 1].key);
  });

  const preamble = begin > 0 ? read(0, begin - 1).map((r) => r.text).join("\n") : "";
  return { units, macros: macrosOf(preamble) };
}
