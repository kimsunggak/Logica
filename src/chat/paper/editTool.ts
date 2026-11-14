/** apply_paper_edits: validate model arguments, then prepare exact source replacements. */
import { locateEdit, type ProposedEdit } from "../../ai/agent/edits";
import { AIError } from "../../ai/errors";
import { ALL_SECTIONS, APPLY_PAPER_EDITS } from "../../ai/tools/chatTools";
import type { AIResponse, SourceRange } from "../../ai/types";
import { t, type MessageKey } from "../../i18n";
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

/** Why a model's apply_paper_edits call cannot be queued. */
export type EditRejectionReason =
  | "incomplete"
  | "no_tool_call"
  | "tool_calls"
  | "arguments"
  | "summary"
  | "no_edits"
  | "shape"
  | "path"
  | "blank"
  | "unchanged"
  | "whitespace"
  | "outside"
  | "ambiguous"
  | "not_found";

/** A rejected proposal: the failed check, and the edit and text it failed on. */
export interface EditRejection {
  reason: EditRejectionReason;
  /** 1-based number of the edit it concerns. */
  edit?: number;
  path?: string;
  /** The start of that edit's original text, as the model wrote it. */
  original?: string;
  /** The tools the model called instead of one apply_paper_edits call. */
  toolCalls?: string[];
  /** The start of the model's text, when it answered without the tool. */
  text?: string;
}

const REASON_MESSAGES: Record<EditRejectionReason, MessageKey> = {
  incomplete: "edits.reject.incomplete",
  no_tool_call: "edits.reject.noToolCall",
  tool_calls: "edits.reject.toolCalls",
  arguments: "edits.reject.arguments",
  summary: "edits.reject.summary",
  no_edits: "edits.reject.noEdits",
  shape: "edits.reject.shape",
  path: "edits.reject.path",
  blank: "edits.reject.blank",
  unchanged: "edits.reject.unchanged",
  whitespace: "edits.reject.whitespace",
  outside: "edits.reject.outside",
  ambiguous: "edits.reject.ambiguous",
  not_found: "edits.reject.notFound",
};

/** A proposal that cannot be queued; the message names the check it failed. */
export class EditProposalError extends AIError {
  readonly rejection: EditRejection;

  constructor(rejection: EditRejection) {
    const reason = t(REASON_MESSAGES[rejection.reason], { n: rejection.edit ?? "", path: rejection.path ?? "" });
    super("malformed_response", t("chat.invalidEdits", { reason }));
    this.rejection = rejection;
  }
}

const EXCERPT_CHARS = 300;

function excerpt(text: string): string {
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) count++;
  return count;
}

/** Why `original` has no single place in the editable sources of its file. */
function missingReason(own: SourceRange[], original: string, file: string | undefined): EditRejectionReason {
  if (own.reduce((n, s) => n + occurrences(s.text, original), 0) > 1) return "ambiguous";
  // Models often rewrite blank lines and indentation when they copy text.
  if (own.some((s) => locateEdit(s.text, original))) return "whitespace";
  // In the file, but in a read-only section or across the end of an editable one.
  if (file?.includes(original)) return "outside";
  return "not_found";
}

/**
 * `texts`: the files the sources were cut from, to place each edit in its file.
 * `evidenceIds`: the web evidence the edit was given; each edit keeps the known ids it names.
 * Throws an `EditProposalError` that names the check the call failed.
 */
export function readEditProposal(response: AIResponse, sources: SourceRange[], texts?: ReadonlyMap<string, string>, evidenceIds: readonly string[] = []): EditProposal {
  const calls = response.toolCalls ?? [];
  if (response.finishReason !== "stop") throw new EditProposalError({ reason: "incomplete" });
  if (!calls.length) throw new EditProposalError({ reason: "no_tool_call", text: excerpt(response.text) });
  const call = calls[0];
  if (calls.length !== 1 || call.name !== APPLY_PAPER_EDITS) throw new EditProposalError({ reason: "tool_calls", toolCalls: calls.map((c) => c.name) });
  if (call.argumentsError) throw new EditProposalError({ reason: "arguments" });
  const { edits, summary } = call.arguments;
  if (typeof summary !== "string" || !summary.trim()) throw new EditProposalError({ reason: "summary" });
  if (!Array.isArray(edits) || !edits.length) throw new EditProposalError({ reason: "no_edits" });
  const parsed: ProposedEdit[] = edits.map((item: unknown, index: number) => {
    const n = index + 1;
    if (!item || typeof item !== "object") throw new EditProposalError({ reason: "shape", edit: n });
    const { path, original, revised, evidence } = item as Record<string, unknown>;
    if (typeof path !== "string" || typeof original !== "string" || typeof revised !== "string") throw new EditProposalError({ reason: "shape", edit: n });
    if (!validEditPath(path)) throw new EditProposalError({ reason: "path", edit: n, path });
    const at = { edit: n, path, original: excerpt(original) };
    if (!original.trim()) throw new EditProposalError({ reason: "blank", ...at });
    if (original === revised) throw new EditProposalError({ reason: "unchanged", ...at });
    const own = sources.filter((s) => s.path === path);
    const matches = own.filter((s) => locateExact(s.text, original));
    if (matches.length !== 1) throw new EditProposalError({ reason: missingReason(own, original, texts?.get(path)), ...at });
    const anchor = anchorOf(texts?.get(path), matches[0], original);
    const used = Array.isArray(evidence) ? [...new Set(evidence.filter((id): id is string => typeof id === "string" && evidenceIds.includes(id)))] : [];
    return { path, original, revised, ...(anchor ? { anchor } : {}), ...(used.length ? { evidence: used } : {}) };
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
