/**
 * Paper map: a compact list of every section with a short key, its size and
 * how it opens. The section selector reads it to decide which parts of the
 * paper a question needs, so the full paper is never sent for that step.
 */
import { sectionSource, sectionTrail, type PaperDocument, type PaperSection } from "../../latex/parser/documentModel";
import { latexToPlain } from "../../latex/parser/text";

export interface MapEntry {
  key: string;
  section: PaperSection;
  /** "3 Method › 3.2 Routing" */
  label: string;
}

export interface PaperMap {
  text: string;
  entries: MapEntry[];
}

const LIMITS = {
  sections: 200,
  abstract: 800,
  /** Characters of each section's opening shown in the map. */
  opening: 160,
};

function opening(doc: PaperDocument, section: PaperSection, files: Map<string, string>): string {
  // Skip the heading line itself; read just enough source for the first sentence.
  const body = sectionSource(doc, section, files, LIMITS.opening * 4).split("\n").slice(1).join("\n");
  const plain = latexToPlain(body);
  return plain.length > LIMITS.opening ? `${plain.slice(0, LIMITS.opening)}…` : plain;
}

export function buildPaperMap(doc: PaperDocument, files: Map<string, string>): PaperMap {
  const sections = doc.flatSections.filter((s) => s.order >= 0).slice(0, LIMITS.sections);
  const minLevel = sections.length ? Math.min(...sections.map((s) => s.level)) : 0;
  const entries: MapEntry[] = [];
  const lines: string[] = [];
  if (doc.title) lines.push(`title: ${doc.title}`);
  if (doc.abstract) {
    const abstract = doc.abstract.length > LIMITS.abstract ? `${doc.abstract.slice(0, LIMITS.abstract)}…` : doc.abstract;
    lines.push(`abstract: ${abstract}`);
  }
  lines.push("sections:");
  sections.forEach((section, i) => {
    const key = `s${i + 1}`;
    entries.push({ key, section, label: sectionTrail(doc, section) });
    const indent = "  ".repeat(Math.max(0, section.level - minLevel));
    const name = `${section.number ? `${section.number} ` : ""}${section.title}`;
    const start = opening(doc, section, files);
    lines.push(`${indent}[${key}] ${name} (${section.wordCount} words)${start ? `: ${start}` : ""}`);
  });
  return { text: lines.join("\n"), entries };
}
