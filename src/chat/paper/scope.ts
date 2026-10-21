/**
 * What a turn reads of the paper. The judge picks the sections a message
 * needs word for word from the paper map; the others are read as their
 * summaries from the paper report.
 *
 *   no summary in the report yet   the whole paper, as files (the first paper turn)
 *   sections: ["all"]              the whole paper, as files
 *   sections: ["3.2"]              3.2 and the front matter word for word, the rest as summaries
 *
 * A section without a current summary (new, or edited since it was
 * summarized) is always read word for word. Asking for a section brings its
 * subsections too.
 */
import { ALL_SECTIONS } from "../../ai/tools/chatTools";
import type { MapEntry, PaperView, ProjectFile, ViewSection } from "../../ai/types";
import { FRONT, type SectionUnit } from "./sections";

/** The paper as one turn reads it. */
export interface Paper {
  /** The whole paper as files in reading order, within the budget. */
  files: ProjectFile[];
  omitted: string[];
  budget: number;
  /** The paper as section units, and the summaries the report has for them, by key. */
  units?: SectionUnit[];
  summaries?: Map<string, string>;
  macros?: string;
  /** A file open in the editor that is not part of the paper. */
  openFile?: ProjectFile;
}

export interface Scope {
  /** `full`: the whole paper as files; `sections`: the paper section by section. */
  kind: "full" | "sections";
  /** Why the whole paper is read. */
  why?: "no_summaries" | "all";
  /** Keys read word for word, in reading order. */
  full: string[];
  /** Keys read as their summaries. */
  summarized: string[];
  /** Keys read word for word because they have no summary yet. */
  unsummarized: string[];
  /** Keys left out to fit the budget. */
  omitted: string[];
  /** Keys asked for that are not sections of the paper. */
  unknown: string[];
  /** Characters of paper text sent. */
  chars: number;
}

/** The sections the judge picks from, or nothing when the paper has no sections. */
export function paperMap(paper: Paper): MapEntry[] | undefined {
  if (!paper.units?.length) return undefined;
  return paper.units.map((u) => {
    const summary = paper.summaries?.get(u.key);
    return {
      key: u.key,
      title: u.title,
      depth: u.depth,
      words: u.words,
      labels: u.labels,
      ...(summary ? { summary } : {}),
      ...(u.key === FRONT ? { always: true } : {}),
    };
  });
}

export function resolveScope(paper: Paper, requested: string[] | undefined): Scope {
  const units = paper.units ?? [];
  const summaries = paper.summaries ?? new Map<string, string>();
  const asked = [...new Set((requested ?? []).map((k) => k.trim()).filter(Boolean))];
  const byKey = new Map(units.map((u) => [u.key, u]));
  const unknown = asked.filter((k) => k !== ALL_SECTIONS && !byKey.has(k));
  const none = { full: [], summarized: [], unsummarized: [], omitted: [], unknown };
  if (!units.some((u) => summaries.has(u.key))) {
    return { kind: "full", why: "no_summaries", ...none, chars: paper.files.reduce((n, f) => n + f.text.length, 0) };
  }
  if (asked.includes(ALL_SECTIONS)) return { kind: "full", why: "all", ...none, chars: paper.files.reduce((n, f) => n + f.text.length, 0) };

  // Word for word, in this order while the budget lasts: the front matter, the
  // sections asked for with their subsections, then the sections without a summary.
  const order: string[] = [];
  const want = (key: string) => {
    if (byKey.has(key) && !order.includes(key)) order.push(key);
  };
  want(FRONT);
  for (const key of asked) {
    want(key);
    for (const u of units) if (u.parentKey === key) want(u.key);
  }
  for (const u of units) if (!summaries.has(u.key)) want(u.key);
  let chars = paper.openFile?.text.length ?? 0;
  const fits = new Set<string>();
  for (const key of order) {
    const size = byKey.get(key)!.chars;
    if (chars + size > paper.budget) continue;
    fits.add(key);
    chars += size;
  }

  const scope: Scope = { kind: "sections", full: [], summarized: [], unsummarized: [], omitted: [], unknown, chars };
  for (const u of units) {
    const summary = summaries.get(u.key);
    if (fits.has(u.key)) {
      scope.full.push(u.key);
      if (!summary && u.key !== FRONT) scope.unsummarized.push(u.key);
    } else if (summary) {
      scope.summarized.push(u.key);
      scope.chars += summary.length;
    } else {
      scope.omitted.push(u.key);
    }
  }
  return scope;
}

/** The request fields for a scope: the whole paper as files, or the paper section by section. */
export function paperRequest(paper: Paper, scope: Scope): { projectFiles: ProjectFile[]; omittedFiles: string[] } | { paperView: PaperView } {
  if (scope.kind === "full") return { projectFiles: paper.files, omittedFiles: paper.omitted };
  const full = new Set(scope.full);
  const sections = (paper.units ?? []).map((u): ViewSection => {
    const base = { key: u.key, title: u.title, depth: u.depth };
    if (full.has(u.key)) return { ...base, content: "full", sources: u.sources };
    const summary = paper.summaries?.get(u.key);
    return summary ? { ...base, content: "summary", summary } : { ...base, content: "omitted" };
  });
  return { paperView: { sections, ...(paper.macros ? { macros: paper.macros } : {}), ...(paper.openFile ? { openFile: paper.openFile } : {}) } };
}

/** What the debugger shows of a scope. */
export function describeScope(scope: Scope) {
  const extra = {
    ...(scope.unsummarized.length ? { unsummarized: scope.unsummarized } : {}),
    ...(scope.omitted.length ? { omitted: scope.omitted } : {}),
    ...(scope.unknown.length ? { unknown: scope.unknown } : {}),
  };
  if (scope.kind === "full") return { kind: "full", why: scope.why, chars: scope.chars, ...extra };
  return { kind: "sections", full: scope.full, summarized: scope.summarized.length, chars: scope.chars, ...extra };
}
