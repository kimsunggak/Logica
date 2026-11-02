/**
 * The Web Research Module's findings as evidence for the Paper Edit Module.
 *
 * The research text has one finding per line. A line is evidence only when
 * the provider cites a source for it (Claude: the text block's citations,
 * OpenAI: url_citation annotations); a line the model wrote without a
 * citation was not checked against a search result and is dropped. Lines
 * marked `NOT FOUND:` are what the search could not answer.
 */
import { NOT_FOUND } from "../prompts/research";
import type { TextCitation, WebEvidence } from "../types";

/** Findings kept for one edit, and the longest finding and quote. */
export const MAX_EVIDENCE = 10;
const MAX_FINDING = 500;
const MAX_QUOTE = 300;

export interface ResearchFindings {
  evidence: WebEvidence[];
  /** Questions the search could not answer; every question when nothing was found. */
  gaps: string[];
}

/** A finding as plain text: no list marker, and no markdown links to its sources (OpenAI writes them inline). */
function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, "$1")
    .trim();
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildEvidence(text: string, citations: TextCitation[], questions: string[]): ResearchFindings {
  const byFinding = new Map<string, WebEvidence>();
  const gaps: string[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const finding = cleanLine(line);
    if (!finding) continue;
    if (finding.toUpperCase().startsWith(NOT_FOUND)) {
      const gap = finding.slice(NOT_FOUND.length).trim();
      if (gap && !gaps.includes(gap)) gaps.push(gap);
      continue;
    }
    // The sources cited anywhere on this line.
    const cited = citations.filter((c) => Math.max(c.start, start) < Math.min(Math.max(c.end, c.start + 1), end));
    if (!cited.length) continue;
    const key = cut(finding, MAX_FINDING);
    const entry = byFinding.get(key) ?? { id: "", finding: key, sources: [] };
    for (const c of cited) {
      const known = entry.sources.find((s) => s.url === c.url);
      if (known) {
        if (!known.title && c.title) known.title = c.title;
        if (!known.quote && c.quote) known.quote = cut(c.quote, MAX_QUOTE);
        continue;
      }
      entry.sources.push({ url: c.url, ...(c.title ? { title: c.title } : {}), ...(c.quote ? { quote: cut(c.quote, MAX_QUOTE) } : {}) });
    }
    byFinding.set(key, entry);
  }
  const evidence = [...byFinding.values()].slice(0, MAX_EVIDENCE).map((e, i) => ({ ...e, id: `W${i + 1}` }));
  // Nothing usable came back: the edit must not fill in any of it.
  return { evidence, gaps: evidence.length || gaps.length ? gaps : questions };
}
