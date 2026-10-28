/** apply_paper_edits: validate model arguments, then prepare exact source replacements. */
import type { ProposedEdit } from "../../ai/agent/edits";
import { AIError } from "../../ai/errors";
import { ALL_SECTIONS, APPLY_PAPER_EDITS } from "../../ai/tools/chatTools";
import type { AIResponse, SourceRange } from "../../ai/types";
import { t } from "../../i18n";
import type { Paper, Scope } from "./scope";
import { textHash } from "./sections";

export interface EditProposal {
  callId: string;
  summary: string;
  edits: ProposedEdit[];
}

export function validEditPath(path: string): boolean {
  return !!path && !/[\\:\u0000]/.test(path) && !path.startsWith("/") && path.split("/").every((part) => !!part && part !== "." && part !== "..") && path.endsWith(".tex");
}

/** Exact matching for tool edits: a changed or ambiguous anchor must be regenerated. */
export function locateExact(text: string, original: string): { from: number; to: number } | null {
  if (!original) return null;
  const from = text.indexOf(original);
  if (from < 0 || text.indexOf(original, from + 1) >= 0) return null;
  return { from, to: from + original.length };
}

/** Offset of the start of a 1-based line, or null past the end. */
function lineStart(text: string, line: number): number | null {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return null;
    at = next + 1;
  }
  return at;
}

/** Offsets of ORIGINAL in the whole file, found through the source block the model copied it from. */
function anchorOf(text: string | undefined, source: SourceRange, original: string): ProposedEdit["anchor"] {
  if (text === undefined) return undefined;
  const line = lineStart(text, source.fromLine);
  const start = line === null ? -1 : text.indexOf(source.text, line);
  const inside = locateExact(source.text, original);
  if (start < 0 || !inside) return undefined;
  const from = start + inside.from;
  return text.slice(from, from + original.length) === original ? { from, to: from + original.length, hash: textHash(text) } : undefined;
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

/** `texts`: the files the sources were cut from, to place each edit in its file. */
export function readEditProposal(response: AIResponse, sources: SourceRange[], texts?: ReadonlyMap<string, string>): EditProposal {
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
    const anchor = anchorOf(texts?.get(path), matches[0], original);
    return { path, original, revised, ...(anchor ? { anchor } : {}) };
  });
  return { callId: call.id, summary: summary.trim(), edits: parsed };
}

export interface SourceReplacement extends ProposedEdit {
  from: number;
  to: number;
}

/**
 * Preflight the entire accepted batch before changing any buffer; apply bottom-up per file.
 * `ranges`: where each edit applies (its highlight); without them ORIGINAL must be unique.
 */
export function preparePaperEdits(edits: ProposedEdit[], texts: ReadonlyMap<string, string>, ranges?: readonly ({ from: number; to: number } | null)[]): SourceReplacement[] | null {
  if (!edits.length) return null;
  const replacements: SourceReplacement[] = [];
  for (const [i, edit] of edits.entries()) {
    if (!validEditPath(edit.path) || typeof edit.original !== "string" || typeof edit.revised !== "string") return null;
    const text = texts.get(edit.path);
    const range = ranges?.[i];
    const at = text === undefined ? null : !ranges ? locateExact(text, edit.original) : range && text.slice(range.from, range.to) === edit.original ? range : null;
    if (!at || replacements.some((r) => r.path === edit.path && r.from < at.to && at.from < r.to)) return null;
    replacements.push({ ...edit, ...at });
  }
  return replacements.sort((a, b) => a.path.localeCompare(b.path) || b.from - a.from);
}
