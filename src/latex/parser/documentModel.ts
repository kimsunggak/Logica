/**
 * The internal paper model.
 *
 * `buildPaperDocument` follows `\input` / `\include` from the main file and
 * produces one reading-ordered view of the paper: section tree, title,
 * abstract, labels, references and bibliography files. The outline, the AI
 * context builder, reference navigation and citation completion all use this
 * single model (there is no second parser).
 */
import { parseFile, type FileFacts } from "./parseFile";
import { dirname, joinPath } from "./text";

export interface PaperFile {
  path: string;
  /** Reachable from the main file through \input / \include. */
  included: boolean;
  missing: boolean;
  parent?: string;
  includeLine?: number;
  depth: number;
}

export interface PaperSection {
  id: string;
  level: number;
  command: string;
  title: string;
  rawTitle: string;
  starred: boolean;
  /** Display number such as "3.2" (absent for starred headings). */
  number?: string;
  filePath: string;
  /** 1-based line of the heading command. */
  startLine: number;
  /** Last line of the section when it ends in the same file. */
  endLine?: number;
  wordCount: number;
  children: PaperSection[];
  parentId?: string;
  /** Index in reading order. */
  order: number;
  /** Global reading-order line range (inclusive). */
  startGi: number;
  endGi: number;
}

export interface LabelDef {
  key: string;
  filePath: string;
  line: number;
}

export interface RefUse {
  key: string;
  command: string;
  filePath: string;
  line: number;
}

export interface ParseIssue {
  severity: "error" | "warning";
  message: string;
  filePath?: string;
  line?: number;
}

/** A contiguous run of lines of one file in reading order. */
export interface ReadingSpan {
  filePath: string;
  fromLine: number;
  toLine: number;
  giStart: number;
}

export interface PaperDocument {
  mainFile?: string;
  title?: string;
  titleRaw?: string;
  abstract?: string;
  abstractLocation?: { filePath: string; line: number };
  files: PaperFile[];
  sections: PaperSection[];
  flatSections: PaperSection[];
  labels: LabelDef[];
  refs: RefUse[];
  bibFiles: string[];
  issues: ParseIssue[];
  spans: ReadingSpan[];
  totalLines: number;
  wordCount: number;
  facts: Map<string, FileFacts>;
}

const MAX_INCLUDE_DEPTH = 24;

// Parsing is cheap but runs on every (debounced) edit; reuse facts for
// unchanged files.
const factsCache = new Map<string, { text: string; facts: FileFacts }>();

export function factsFor(path: string, text: string): FileFacts {
  const cached = factsCache.get(path);
  if (cached && cached.text === text) return cached.facts;
  const facts = parseFile(text);
  factsCache.set(path, { text, facts });
  return facts;
}

/** Resolve an \input/\include target the way TeX does (relative to the main file directory). */
export function resolveInclude(
  baseDir: string,
  target: string,
  command: string,
  exists: (path: string) => boolean,
): string {
  const cleaned = target.replace(/^"|"$/g, "").trim();
  const candidate = joinPath(baseDir, cleaned);
  if (command === "include") return candidate.endsWith(".tex") ? candidate : `${candidate}.tex`;
  if (/\.[a-zA-Z0-9]+$/.test(cleaned) && exists(candidate)) return candidate;
  const withTex = `${candidate}.tex`;
  if (exists(withTex)) return withTex;
  if (exists(candidate)) return candidate;
  return /\.tex$/.test(candidate) ? candidate : withTex;
}

/**
 * Pick the root document: `main.tex` if present, otherwise a file with both
 * `\documentclass` and `\begin{document}` (preferring shallow paths).
 */
export function detectMainFile(files: Map<string, string>): string | undefined {
  if (files.has("main.tex")) return "main.tex";
  const candidates: string[] = [];
  for (const [path, text] of files) {
    if (!path.endsWith(".tex")) continue;
    if (/\\documentclass/.test(text) && /\\begin\s*\{document\}/.test(text)) candidates.push(path);
  }
  candidates.sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    if (depth !== 0) return depth;
    const preferred = ["paper.tex", "ms.tex", "manuscript.tex", "thesis.tex", "article.tex"];
    const pa = preferred.indexOf(a.split("/").pop() ?? "");
    const pb = preferred.indexOf(b.split("/").pop() ?? "");
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || a.localeCompare(b);
  });
  return candidates[0];
}

function toLetters(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export function buildPaperDocument(input: {
  mainFile?: string;
  files: Map<string, string>;
}): PaperDocument {
  const { files } = input;
  const mainFile = input.mainFile && files.has(input.mainFile) ? input.mainFile : detectMainFile(files);
  const issues: ParseIssue[] = [];
  const facts = new Map<string, FileFacts>();
  const paperFiles: PaperFile[] = [];
  const spans: ReadingSpan[] = [];
  const visited = new Set<string>();
  let gi = 0;

  if (!mainFile) {
    issues.push({
      severity: "warning",
      message: "No main file found (main.tex or a file with \\documentclass and \\begin{document}).",
    });
  }
  const baseDir = mainFile ? dirname(mainFile) : "";
  const exists = (p: string) => files.has(p);

  const pushSpan = (filePath: string, fromLine: number, toLine: number) => {
    if (toLine < fromLine) return;
    spans.push({ filePath, fromLine, toLine, giStart: gi });
    gi += toLine - fromLine + 1;
  };

  const walk = (path: string, depth: number, parent?: string, includeLine?: number) => {
    if (visited.has(path)) {
      issues.push({
        severity: "warning",
        message: `${path} is included more than once; only the first inclusion is shown.`,
        filePath: parent,
        line: includeLine,
      });
      return;
    }
    visited.add(path);
    const text = files.get(path);
    paperFiles.push({ path, included: true, missing: text === undefined, parent, includeLine, depth });
    if (text === undefined) {
      issues.push({
        severity: "error",
        message: `Included file not found: ${path}`,
        filePath: parent,
        line: includeLine,
      });
      return;
    }
    const fileFacts = factsFor(path, text);
    facts.set(path, fileFacts);
    let from = 1;
    for (const inc of fileFacts.includes) {
      pushSpan(path, from, inc.line);
      const target = resolveInclude(baseDir, inc.target, inc.command, exists);
      if (depth >= MAX_INCLUDE_DEPTH) {
        issues.push({ severity: "error", message: "Include nesting is too deep", filePath: path, line: inc.line });
      } else {
        walk(target, depth + 1, path, inc.line);
      }
      from = Math.max(from, inc.line + 1);
    }
    pushSpan(path, from, fileFacts.lineCount);
  };

  if (mainFile) walk(mainFile, 0);

  // Files of the project that are not part of the main document.
  for (const [path, text] of files) {
    if (!path.endsWith(".tex") || visited.has(path)) continue;
    paperFiles.push({ path, included: false, missing: false, depth: 0 });
    facts.set(path, factsFor(path, text));
  }

  const spansByFile = new Map<string, ReadingSpan[]>();
  for (const span of spans) {
    const list = spansByFile.get(span.filePath) ?? [];
    list.push(span);
    spansByFile.set(span.filePath, list);
  }
  const giOf = (path: string, line: number): number => {
    for (const span of spansByFile.get(path) ?? []) {
      if (line >= span.fromLine && line <= span.toLine) return span.giStart + (line - span.fromLine);
    }
    return -1;
  };

  // Prefix sums of prose words in reading order.
  const prefix = new Float64Array(gi + 1);
  for (const span of spans) {
    const words = facts.get(span.filePath)?.lineWords;
    for (let line = span.fromLine; line <= span.toLine; line++) {
      const g = span.giStart + (line - span.fromLine);
      prefix[g + 1] = prefix[g] + (words?.[line - 1] ?? 0);
    }
  }

  // Document end: \end{document} in the main file, if present.
  let lastGi = gi - 1;
  const mainFacts = mainFile ? facts.get(mainFile) : undefined;
  if (mainFile && mainFacts?.endDocumentLine) {
    const endGi = giOf(mainFile, mainFacts.endDocumentLine);
    if (endGi > 0) lastGi = endGi - 1;
  }

  // Headings in reading order.
  const headingRefs: { path: string; h: FileFacts["headings"][number]; gi: number }[] = [];
  const appendixGis: number[] = [];
  for (const path of visited) {
    const f = facts.get(path);
    if (!f) continue;
    for (const h of f.headings) {
      const g = giOf(path, h.line);
      if (g >= 0 && g <= lastGi) headingRefs.push({ path, h, gi: g });
    }
    for (const line of f.appendixLines) {
      const g = giOf(path, line);
      if (g >= 0) appendixGis.push(g);
    }
  }
  headingRefs.sort((a, b) => a.gi - b.gi || a.h.offset - b.h.offset);
  const appendixGi = appendixGis.length ? Math.min(...appendixGis) : Infinity;

  const numbered = headingRefs.filter((r) => !r.h.starred);
  const topLevel = numbered.length ? Math.min(...numbered.map((r) => r.h.level)) : 1;
  const counters = new Map<number, number>();
  let inAppendix = false;

  const flatSections: PaperSection[] = [];
  const roots: PaperSection[] = [];
  const stack: PaperSection[] = [];
  const idCounts = new Map<string, number>();

  headingRefs.forEach((ref, order) => {
    const { h, path } = ref;
    if (!inAppendix && ref.gi > appendixGi) {
      inAppendix = true;
      counters.set(topLevel, 0);
    }
    let number: string | undefined;
    if (!h.starred && h.level >= topLevel) {
      counters.set(h.level, (counters.get(h.level) ?? 0) + 1);
      for (const level of [...counters.keys()]) if (level > h.level) counters.set(level, 0);
      const parts: string[] = [];
      for (let level = topLevel; level <= h.level; level++) {
        const value = counters.get(level) ?? 0;
        parts.push(level === topLevel && inAppendix ? toLetters(value) : String(value));
      }
      number = parts.join(".");
    }

    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const parent = stack[stack.length - 1];
    const baseId = `${parent ? parent.id : ""}/${h.title}`;
    const dup = idCounts.get(baseId) ?? 0;
    idCounts.set(baseId, dup + 1);

    const section: PaperSection = {
      id: dup ? `${baseId}~${dup}` : baseId,
      level: h.level,
      command: h.command,
      title: h.title,
      rawTitle: h.rawTitle,
      starred: h.starred,
      number,
      filePath: path,
      startLine: h.line,
      wordCount: 0,
      children: [],
      parentId: parent?.id,
      order,
      startGi: ref.gi,
      endGi: lastGi,
    };
    (parent ? parent.children : roots).push(section);
    stack.push(section);
    flatSections.push(section);
  });

  for (let i = 0; i < flatSections.length; i++) {
    const s = flatSections[i];
    for (let j = i + 1; j < flatSections.length; j++) {
      if (flatSections[j].level <= s.level) {
        s.endGi = flatSections[j].startGi - 1;
        break;
      }
    }
    s.endGi = Math.max(s.startGi, Math.min(s.endGi, Math.max(lastGi, s.startGi)));
    s.wordCount = Math.round(prefix[s.endGi + 1] - prefix[s.startGi]);
    const end = locateGi(spans, s.endGi);
    if (end && end.filePath === s.filePath) s.endLine = end.line;
  }

  // Title and abstract: first occurrence in reading order.
  let title: string | undefined;
  let titleRaw: string | undefined;
  let abstract: string | undefined;
  let abstractLocation: PaperDocument["abstractLocation"];
  for (const path of visited) {
    const f = facts.get(path);
    if (!f) continue;
    if (!title && f.title) {
      title = f.title.text;
      titleRaw = f.title.raw;
    }
    if (!abstract && f.abstract) {
      abstract = f.abstract.raw.replace(/\n{3,}/g, "\n\n");
      abstractLocation = { filePath: path, line: f.abstract.line };
    }
  }

  // Labels/refs from the paper first, then from other project files.
  const labels: LabelDef[] = [];
  const refs: RefUse[] = [];
  const bibFiles: string[] = [];
  for (const [path, f] of facts) {
    for (const l of f.labels) labels.push({ key: l.key, filePath: path, line: l.line });
    for (const r of f.refs) refs.push({ key: r.key, command: r.command, filePath: path, line: r.line });
    if (visited.has(path)) {
      for (const res of f.bibResources) {
        const bib = joinPath(baseDir, res.endsWith(".bib") ? res : `${res}.bib`);
        if (!bibFiles.includes(bib)) bibFiles.push(bib);
      }
    }
  }

  const seenLabels = new Map<string, LabelDef>();
  for (const label of labels) {
    const prev = seenLabels.get(label.key);
    if (prev && visited.has(label.filePath) && visited.has(prev.filePath)) {
      issues.push({
        severity: "warning",
        message: `Duplicate label "${label.key}" (also at ${prev.filePath}:${prev.line})`,
        filePath: label.filePath,
        line: label.line,
      });
    } else if (!prev) seenLabels.set(label.key, label);
  }

  return {
    mainFile,
    title,
    titleRaw,
    abstract,
    abstractLocation,
    files: paperFiles,
    sections: roots,
    flatSections,
    labels,
    refs,
    bibFiles,
    issues,
    spans,
    totalLines: gi,
    wordCount: Math.round(prefix[Math.max(0, lastGi + 1)] ?? 0),
    facts,
  };
}

/** Map a global reading-order line back to (file, line). */
export function locateGi(spans: ReadingSpan[], g: number): { filePath: string; line: number } | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    const len = span.toLine - span.fromLine + 1;
    if (g < span.giStart) hi = mid - 1;
    else if (g >= span.giStart + len) lo = mid + 1;
    else return { filePath: span.filePath, line: span.fromLine + (g - span.giStart) };
  }
  return null;
}

/** Global reading-order line of (file, line), or -1 if not part of the paper. */
export function giOf(doc: PaperDocument, filePath: string, line: number): number {
  for (const span of doc.spans) {
    if (span.filePath === filePath && line >= span.fromLine && line <= span.toLine) {
      return span.giStart + (line - span.fromLine);
    }
  }
  return -1;
}

/** Innermost section containing (file, line). */
export function sectionAt(doc: PaperDocument, filePath: string, line: number): PaperSection | null {
  const g = giOf(doc, filePath, line);
  if (g >= 0) {
    let found: PaperSection | null = null;
    for (const s of doc.flatSections) {
      if (s.startGi > g) break;
      if (g <= s.endGi) found = s;
    }
    return found;
  }
  // File outside the main document: use its own headings.
  const facts = doc.facts.get(filePath);
  const local = facts?.headings.filter((h) => h.line <= line).at(-1);
  if (!local) return null;
  return {
    id: `${filePath}#${local.line}`,
    level: local.level,
    command: local.command,
    title: local.title,
    rawTitle: local.rawTitle,
    starred: local.starred,
    filePath,
    startLine: local.line,
    wordCount: 0,
    children: [],
    order: -1,
    startGi: -1,
    endGi: -1,
  };
}

export function findSection(doc: PaperDocument, id: string): PaperSection | undefined {
  return doc.flatSections.find((s) => s.id === id);
}

/** "3 Method › 3.2 Uncertainty-guided Routing" */
export function sectionTrail(doc: PaperDocument, section: PaperSection): string {
  const chain: PaperSection[] = [section];
  let parentId = section.parentId;
  while (parentId) {
    const parent = findSection(doc, parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parent.parentId;
  }
  return chain.map((s) => (s.number ? `${s.number} ${s.title}` : s.title)).join(" › ");
}

/** Indented outline text used in AI prompts. */
export function outlineText(doc: PaperDocument, maxChars = 3000): string {
  const lines: string[] = [];
  const minLevel = doc.flatSections.length ? Math.min(...doc.flatSections.map((s) => s.level)) : 0;
  for (const s of doc.flatSections) {
    const indent = "  ".repeat(Math.max(0, s.level - minLevel));
    lines.push(`${indent}${s.number ? `${s.number} ` : ""}${s.title}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`;
  return text;
}

/** Source text of a section across files, in reading order. */
export function sectionSource(
  doc: PaperDocument,
  section: PaperSection,
  files: Map<string, string>,
  maxChars = 12000,
): string {
  if (section.startGi < 0) return "";
  const out: string[] = [];
  let size = 0;
  const lineCache = new Map<string, string[]>();
  for (let g = section.startGi; g <= section.endGi; g++) {
    const loc = locateGi(doc.spans, g);
    if (!loc) continue;
    let lines = lineCache.get(loc.filePath);
    if (!lines) {
      lines = (files.get(loc.filePath) ?? "").split("\n");
      lineCache.set(loc.filePath, lines);
    }
    const text = lines[loc.line - 1] ?? "";
    out.push(text);
    size += text.length + 1;
    if (size > maxChars) {
      out.push("…");
      break;
    }
  }
  return out.join("\n");
}
