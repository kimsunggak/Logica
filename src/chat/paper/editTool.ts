/** apply_paper_edits: validate model arguments, then prepare exact source replacements. */
import type { ProposedEdit } from "../../ai/agent/edits";
import { AIError } from "../../ai/errors";
import { ALL_SECTIONS, APPLY_PAPER_EDITS } from "../../ai/tools/chatTools";
import type { AIResponse, SourceRange } from "../../ai/types";
import { t } from "../../i18n";
import type { Paper, Scope } from "./scope";

export interface EditProposal {
  callId: string;
  summary: string;
  edits: ProposedEdit[];
}

export function validEditPath(path: string): boolean {
  return !!path && !/[\\:\u0000]/.test(path) && !path.startsWith("/") && path.split("/").every((part) => !!part && part !== "." && part !== "..") && path.endsWith(".tex");
}

/**
 * Exact matching for tool edits: a changed or ambiguous anchor must be
 * regenerated. When the text also appears elsewhere in the file, `lines` (the
 * source block it was copied from) decides which occurrence is meant.
 */
export function locateExact(text: string, original: string, lines?: ProposedEdit["lines"]): { from: number; to: number } | null {
  if (!original) return null;
  const hits: number[] = [];
  for (let at = text.indexOf(original); at >= 0; at = text.indexOf(original, at + 1)) hits.push(at);
  let from = hits.length === 1 ? hits[0] : undefined;
  if (hits.length > 1 && lines) {
    const block = lineSpan(text, lines);
    const inside = block ? hits.filter((at) => at >= block.from && at + original.length <= block.to) : [];
    if (inside.length === 1) from = inside[0];
  }
  return from === undefined ? null : { from, to: from + original.length };
}

/** Offsets of lines `from`..`to` (1-based, inclusive), without the line break that ends them. */
function lineSpan(text: string, lines: { from: number; to: number }): { from: number; to: number } | null {
  let start = 0;
  for (let line = 1; line < lines.from; line++) {
    const next = text.indexOf("\n", start);
    if (next < 0) return null;
    start = next + 1;
  }
  let end = start;
  for (let line = lines.from; line <= lines.to; line++) {
    const next = text.indexOf("\n", end);
    if (next < 0) return { from: start, to: text.length };
    end = line === lines.to ? next : next + 1;
  }
  return { from: start, to: end };
}

/** All selected edit and reference sections must actually have been sent in full. */
export function requireFullSections(paper: Paper, scope: Scope, selected: string[]): void {
  if (scope.unknown.length) throw new AIError("malformed_response", t("chat.invalidSections"));
  if (scope.kind === "full") {
    if (paper.omitted.length) throw new AIError("bad_request", t("chat.editSourceLimit"));
    return;
  }
  const keys = expandedKeys(paper, selected);
  if (keys.some((key) => !scope.full.includes(key))) throw new AIError("bad_request", t("chat.editSourceLimit"));
}

function expandedKeys(paper: Paper, selected: string[]): string[] {
  const units = paper.units ?? [];
  if (selected.includes(ALL_SECTIONS)) return units.map((u) => u.key);
  return units.filter((u) => selected.includes(u.key) || (u.parentKey && selected.includes(u.parentKey))).map((u) => u.key);
}

/** Only edit targets are writable; full reference sections remain read-only. */
export function editableSources(paper: Paper, selected: string[]): SourceRange[] {
  if (selected.includes(ALL_SECTIONS)) {
    return paper.files.map((f) => ({ ...f, fromLine: 1, toLine: f.text.split("\n").length }));
  }
  const keys = new Set(expandedKeys(paper, selected));
  return (paper.units ?? []).filter((u) => keys.has(u.key)).flatMap((u) => u.sources);
}

export function readEditProposal(response: AIResponse, sources: SourceRange[]): EditProposal {
  const call = response.toolCalls?.[0];
  const invalid = () => new AIError("malformed_response", t("chat.invalidEdits"));
  if (response.finishReason !== "stop" || response.toolCalls?.length !== 1 || call?.name !== APPLY_PAPER_EDITS || call.argumentsError) throw invalid();
  const { edits, summary } = call.arguments;
  if (typeof summary !== "string" || !summary.trim() || !Array.isArray(edits) || !edits.length) throw invalid();
  const parsed: ProposedEdit[] = edits.map((item: unknown) => {
    if (!item || typeof item !== "object") throw invalid();
    const { path, original, revised } = item as Record<string, unknown>;
    if (typeof path !== "string" || !validEditPath(path) || typeof original !== "string" || !original.trim() || typeof revised !== "string" || original === revised) throw invalid();
    const matches = sources.filter((s) => s.path === path && locateExact(s.text, original));
    if (matches.length !== 1) throw invalid();
    return { path, original, revised, lines: { from: matches[0].fromLine, to: matches[0].toLine } };
  });
  return { callId: call.id, summary: summary.trim(), edits: parsed };
}

export interface SourceReplacement extends ProposedEdit {
  from: number;
  to: number;
}

/** Preflight the entire accepted batch before changing any buffer; apply bottom-up per file. */
export function preparePaperEdits(edits: ProposedEdit[], texts: ReadonlyMap<string, string>): SourceReplacement[] | null {
  if (!edits.length) return null;
  const replacements: SourceReplacement[] = [];
  for (const edit of edits) {
    if (!validEditPath(edit.path) || typeof edit.original !== "string" || typeof edit.revised !== "string") return null;
    const text = texts.get(edit.path);
    const at = text === undefined ? null : locateExact(text, edit.original, edit.lines);
    if (!at || replacements.some((r) => r.path === edit.path && r.from < at.to && at.from < r.to)) return null;
    replacements.push({ ...edit, ...at });
  }
  return replacements.sort((a, b) => a.path.localeCompare(b.path) || b.from - a.from);
}
