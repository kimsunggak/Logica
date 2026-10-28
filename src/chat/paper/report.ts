/**
 * The paper summary: one short summary per section unit, for each project,
 * kept as a YAML document in the app's local data folder
 * (`<app local data>/papers/<project id>/paper-summary.yaml`) and shared by
 * every chat session of the project.
 *
 *   title: …
 *   sections:
 *     - key: metadata        title/author fields extracted by code
 *     - key: abstract        body front matter and abstract
 *     - key: "1"             Introduction, with its subsections under it
 *       subsections:
 *         - key: "1.1"
 *
 * The document follows the paper's reading order. Summaries are found by the
 * unit's text hash, so an edited section has no summary until the Paper Summary Module
 * (`./sectionSummarizer.ts`) writes one; until then it is read
 * word for word. A paper with no summary at all has not been read yet: the
 * Paper Summary Module summarizes it before the first answer.
 */
import { Document, parse } from "yaml";
import { call } from "../../lib/backend";
import type { SectionUnit } from "./sections";
import { METADATA } from "./metadata";

export const REPORT_VERSION = 1;

export interface SectionSummary {
  title: string;
  summary: string;
}

export interface PaperReport {
  /** By the unit's text hash. */
  summaries: Record<string, SectionSummary>;
}

export function emptyReport(): PaperReport {
  return { summaries: {} };
}

/** The summary of each unit that has one, by unit key. */
export function summariesFor(units: SectionUnit[], report: PaperReport): Map<string, string> {
  const found = new Map<string, string>();
  for (const unit of units) {
    const entry = report.summaries[unit.hash];
    if (unit.summary !== undefined || entry) found.set(unit.key, unit.summary ?? entry.summary);
  }
  return found;
}

/** Whether any section of the paper has a summary: false until the paper is first summarized. */
export function hasSummaries(units: SectionUnit[], report: PaperReport): boolean {
  const body = units.filter((unit) => unit.key !== METADATA);
  return (body.length ? body : units).some((unit) => report.summaries[unit.hash]);
}

/** The units the report has no summary for. */
export function unitsToSummarize(units: SectionUnit[], report: PaperReport): SectionUnit[] {
  return units.filter((unit) => !report.summaries[unit.hash]);
}

/** The report with new summaries added, keeping only the sections the paper has now. */
export function withSummaries(report: PaperReport, added: { hash: string; title: string; summary: string }[], units: SectionUnit[]): PaperReport {
  const all: Record<string, SectionSummary> = { ...report.summaries };
  for (const entry of added) all[entry.hash] = { title: entry.title, summary: entry.summary };
  const summaries: Record<string, SectionSummary> = {};
  for (const unit of units) if (all[unit.hash]) summaries[unit.hash] = all[unit.hash];
  for (const unit of units) if (unit.summary !== undefined) summaries[unit.hash] = { title: unit.title, summary: unit.summary };
  return { summaries };
}

interface DocEntry {
  key: string;
  title: string;
  hash: string;
  /** null while the section has no summary yet. */
  summary: string | null;
  subsections?: DocEntry[];
}

/** The report as the YAML document saved for the paper: its sections in reading order. */
export function reportYaml(report: PaperReport, units: SectionUnit[], title?: string, now = new Date()): string {
  const entry = (unit: SectionUnit): DocEntry => ({ key: unit.key, title: unit.title, hash: unit.hash, summary: unit.summary ?? report.summaries[unit.hash]?.summary ?? null });
  const sections: DocEntry[] = [];
  const parents = new Map<string, DocEntry>();
  for (const unit of units) {
    const parent = unit.parentKey ? parents.get(unit.parentKey) : undefined;
    if (parent) (parent.subsections ??= []).push(entry(unit));
    else {
      const made = entry(unit);
      sections.push(made);
      parents.set(unit.key, made);
    }
  }
  const doc = new Document({ version: REPORT_VERSION, ...(title ? { title } : {}), updated: now.toISOString(), sections });
  doc.commentBefore = [
    " LOGICA 논문 요약: 섹션마다 3~4줄, 논문의 읽는 순서대로.",
    " metadata는 제목·저자 선언에서 코드로 추출한 정보입니다. 별도 LLM 요약을 하지 않습니다.",
    " Paper Orchestra는 각 섹션의 요약을 읽고, 질문에 필요한 섹션을 선택합니다.",
    " 답변 모델에는 선택한 섹션의 원문과 나머지 섹션의 요약을 보냅니다.",
    " hash는 각 영역 원문의 해시입니다. 원문을 고치면 해당 영역의 정보나 요약을 갱신합니다.",
  ].join("\n");
  return doc.toString({ lineWidth: 0, blockQuote: "literal" });
}

/** A saved document read back; anything unreadable starts empty. */
export function readReportYaml(text: string | null | undefined): PaperReport {
  const report = emptyReport();
  if (!text) return report;
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    return report;
  }
  const doc = value as { version?: unknown; sections?: unknown } | null;
  if (doc?.version !== REPORT_VERSION || !Array.isArray(doc.sections)) return report;
  const walk = (entries: unknown[]) => {
    for (const item of entries) {
      const e = item as Partial<DocEntry> | null;
      if (typeof e?.hash === "string" && typeof e.summary === "string" && e.summary.trim()) {
        report.summaries[e.hash] = { title: typeof e.title === "string" ? e.title : "", summary: e.summary.trim() };
      }
      if (Array.isArray(e?.subsections)) walk(e.subsections);
    }
  };
  walk(doc.sections);
  return report;
}

// ---------------------------------------------------------------- storage

const loaded = new Map<string, PaperReport>();

/** The project's paper summary, read from disk once per app run. */
export async function loadReport(root: string): Promise<PaperReport> {
  const known = loaded.get(root);
  if (known) return known;
  const report = readReportYaml(await call<string | null>("paper_load_summary", { root }).catch(() => null));
  // A save may have landed while the file was read.
  const now = loaded.get(root) ?? report;
  loaded.set(root, now);
  return now;
}

/** Keep the report and write it as the paper's YAML document. */
export async function saveReport(root: string, report: PaperReport, units: SectionUnit[], title?: string): Promise<void> {
  loaded.set(root, report);
  await call<void>("paper_save_summary", { root, text: reportYaml(report, units, title) }).catch(() => {
    // Saving is best effort; the summaries stay usable in memory.
  });
}

/** Forget what was read, so the next load reads the file again (for tests). */
export function forgetReports() {
  loaded.clear();
}
