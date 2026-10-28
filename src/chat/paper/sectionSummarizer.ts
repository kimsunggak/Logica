/**
 * Paper Summary Module: summarizes the sections of the paper that the
 * paper summary has no summary for, from the abstract on, in reading order.
 *
 *   first question about a paper   every section, before the judge runs
 *   after later turns              only sections edited since, in the background
 *
 * Sections go in batches of about 40,000 characters, one model call each. A
 * section with no text of its own yet is "아직 내용 없음", and one with only
 * a few words is its own summary. A section the model leaves out, or a batch
 * that fails, is tried again after the next turn and is read word for word
 * until then.
 */
import { AIError } from "../../ai/errors";
import { callModel, type RunControl } from "../../ai/gateway";
import { SECTION_TOOLS, WRITE_SECTION_SUMMARIES } from "../../ai/tools/sectionTools";
import type { AIResponse } from "../../ai/types";
import { step, traced, type Span } from "../../debug/trace";
import { latexToPlain } from "../../latex/parser/text";
import { capText } from "../session/turns";
import { unitText, type SectionUnit } from "./sections";

export const SECTION_BATCH_CHARS = 40_000;
/** Longest section text sent; a longer one keeps its start and end. */
const SECTION_TEXT_CHARS = 20_000;
/** A section with fewer prose words after its heading is summarized by its own text. */
const SHORT_WORDS = 12;
/** The summary of a section with no text of its own yet. */
export const NO_CONTENT = "아직 내용 없음";

export interface SummarizedSection {
  key: string;
  hash: string;
  title: string;
  summary: string;
}

export interface SectionSummaryOptions {
  traceId: string;
  /** The turn's root span, so the debugger shows the run in that turn. */
  parent?: Span | null;
  control: RunControl;
  /** The paper's title and outline, so the summaries use its terms. */
  title?: string;
  outline?: string;
  call?: typeof callModel;
}

export interface SectionSummaryResult {
  summarized: SummarizedSection[];
  /** Keys of sections still without a summary. */
  missing: string[];
}

/** Batches of sections, each up to the batch size (a longer section goes alone). */
export function batchesOf(units: SectionUnit[]): SectionUnit[][] {
  const batches: SectionUnit[][] = [];
  let size = Infinity;
  for (const unit of units) {
    const chars = Math.min(unit.chars, SECTION_TEXT_CHARS);
    if (size + chars > SECTION_BATCH_CHARS) {
      batches.push([]);
      size = 0;
    }
    batches[batches.length - 1].push(unit);
    size += chars;
  }
  return batches;
}

/** A short section's own text, without its heading, or that it has none yet. */
function ownWords(unit: SectionUnit): string {
  if (unit.bodyWords === 0) return NO_CONTENT;
  return latexToPlain(unitText(unit)).replace(unit.title, "").trim() || NO_CONTENT;
}

/** The summaries the model wrote for the sections of `batch`, by key. */
function readSummaries(response: AIResponse, batch: SectionUnit[]): SummarizedSection[] {
  const toolCall = response.toolCalls?.find((c) => c.name === WRITE_SECTION_SUMMARIES);
  if (!toolCall || toolCall.argumentsError) {
    throw new AIError("unknown", toolCall ? "The Paper Summary Module sent unreadable summaries" : "The Paper Summary Module did not call write_section_summaries");
  }
  const written = new Map<string, string>();
  const entries = Array.isArray(toolCall.arguments.summaries) ? toolCall.arguments.summaries : [];
  for (const entry of entries as { key?: unknown; summary?: unknown }[]) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    const summary = typeof entry?.summary === "string" ? entry.summary.trim() : "";
    if (key && summary && !written.has(key)) written.set(key, summary);
  }
  return batch.filter((u) => written.has(u.key)).map((u) => ({ key: u.key, hash: u.hash, title: u.title, summary: written.get(u.key)! }));
}

/** Summarize `units` with the Paper Summary Module, one call per batch. */
export async function summarizeSections(units: SectionUnit[], options: SectionSummaryOptions): Promise<SectionSummaryResult> {
  const call = options.call ?? callModel;
  return traced(
    options.traceId,
    options.parent ?? null,
    "sections",
    "runPaperSummaryModule",
    () => ({ sections: units.map((u) => ({ key: u.key, title: u.title, chars: u.chars })) }),
    async (span) => {
      const summarized: SummarizedSection[] = units
        .filter((u) => u.summary !== undefined || u.bodyWords < SHORT_WORDS)
        .map((u) => ({ key: u.key, hash: u.hash, title: u.title, summary: u.summary ?? ownWords(u) }));
      const missing: string[] = [];
      let failure: unknown = null;
      const batches = batchesOf(units.filter((u) => u.summary === undefined && u.bodyWords >= SHORT_WORDS));
      for (const [i, batch] of batches.entries()) {
        try {
          const result = await call(
            "sections",
            {
              id: `${options.traceId}-sections-${i + 1}`,
              instruction: "",
              context: { ...(options.title ? { paperTitle: options.title } : {}), ...(options.outline ? { outline: options.outline } : {}) },
              sectionsToSummarize: batch.map((u) => ({ key: u.key, title: u.title, text: capText(unitText(u), SECTION_TEXT_CHARS) })),
              tools: SECTION_TOOLS,
            },
            { control: options.control, trace: { traceId: options.traceId, parent: span } },
          );
          const written = readSummaries(result.response, batch);
          const left = batch.filter((u) => !written.some((w) => w.key === u.key)).map((u) => u.key);
          step(options.traceId, span, "sections", "readSectionSummaries", () => batch.map((u) => u.key), () => ({ written: written.map((w) => w.key), missing: left }));
          summarized.push(...written);
          missing.push(...left);
        } catch (err) {
          if (err instanceof AIError && err.kind === "cancelled") throw err;
          missing.push(...batch.map((u) => u.key));
          failure = err;
        }
      }
      // Nothing written: report the failure, so the run shows as failed.
      if (failure && summarized.length === 0) throw failure;
      return { summarized, missing };
    },
    (r) => ({ summarized: r.summarized.length, missing: r.missing, summaries: r.summarized.map((s) => `[${s.key}] ${s.summary}`).join("\n") }),
  );
}
