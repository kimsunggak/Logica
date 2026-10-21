/**
 * The paper report: one summary per section unit, for each project, kept in
 * the app's local data folder (`<app local data>/papers/<project id>/report.json`)
 * and shared by every chat session of the project.
 *
 * Summaries are found by the unit's text hash, so an edited section has no
 * summary until the Section Summary Module (`./sectionSummarizer.ts`) writes
 * one; until then it is read word for word. A report with no summary for
 * the paper means the paper has not been read yet: the whole paper is sent.
 */
import { call } from "../../lib/backend";
import { FRONT, type SectionUnit } from "./sections";

export const REPORT_VERSION = 1;
/** Summaries of sections no longer in the paper are kept for this many entries, newest first. */
const KEEP_OLD = 200;

export interface SectionSummary {
  title: string;
  summary: string;
  updatedAt: number;
}

export interface PaperReport {
  version: number;
  /** By the unit's text hash. */
  summaries: Record<string, SectionSummary>;
}

export function emptyReport(): PaperReport {
  return { version: REPORT_VERSION, summaries: {} };
}

/** A report read from disk; anything unreadable starts empty. */
export function readReport(value: unknown): PaperReport {
  const report = emptyReport();
  const summaries = (value as { version?: unknown; summaries?: unknown } | null)?.summaries;
  if ((value as { version?: unknown } | null)?.version !== REPORT_VERSION || !summaries || typeof summaries !== "object") return report;
  for (const [hash, entry] of Object.entries(summaries as Record<string, unknown>)) {
    const e = entry as Partial<SectionSummary> | null;
    if (typeof e?.summary === "string" && e.summary.trim()) {
      report.summaries[hash] = { title: typeof e.title === "string" ? e.title : "", summary: e.summary, updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0 };
    }
  }
  return report;
}

/** The summary of each unit that has one, by unit key. The front matter is always read word for word. */
export function summariesFor(units: SectionUnit[], report: PaperReport): Map<string, string> {
  const found = new Map<string, string>();
  for (const unit of units) {
    const entry = unit.key === FRONT ? undefined : report.summaries[unit.hash];
    if (entry) found.set(unit.key, entry.summary);
  }
  return found;
}

/** The units the report has no summary for. */
export function unitsToSummarize(units: SectionUnit[], report: PaperReport): SectionUnit[] {
  return units.filter((unit) => unit.key !== FRONT && !report.summaries[unit.hash]);
}

/** Add new summaries; keep those of the current units and the newest of the rest. */
export function withSummaries(report: PaperReport, added: { hash: string; title: string; summary: string }[], units: SectionUnit[], now = Date.now()): PaperReport {
  const summaries: Record<string, SectionSummary> = { ...report.summaries };
  for (const entry of added) summaries[entry.hash] = { title: entry.title, summary: entry.summary, updatedAt: now };
  const current = new Set(units.map((u) => u.hash));
  const old = Object.entries(summaries)
    .filter(([hash]) => !current.has(hash))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(KEEP_OLD);
  for (const [hash] of old) delete summaries[hash];
  return { version: REPORT_VERSION, summaries };
}

// ---------------------------------------------------------------- storage

const loaded = new Map<string, PaperReport>();

/** The project's report, read from disk once per app run. */
export async function loadReport(root: string): Promise<PaperReport> {
  const known = loaded.get(root);
  if (known) return known;
  const report = readReport(await call<unknown>("paper_load_report", { root }).catch(() => null));
  // A save may have landed while the file was read.
  const now = loaded.get(root) ?? report;
  loaded.set(root, now);
  return now;
}

export async function saveReport(root: string, report: PaperReport): Promise<void> {
  loaded.set(root, report);
  await call<void>("paper_save_report", { root, report }).catch(() => {
    // Saving is best effort; the summaries stay usable in memory.
  });
}

/** Forget what was read, so the next load reads the file again (for tests). */
export function forgetReports() {
  loaded.clear();
}
