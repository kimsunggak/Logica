/**
 * Section selection result: parse the selector's JSON reply and gather the
 * source of the chosen sections within a size budget.
 */
import { sectionSource, type PaperDocument } from "../../latex/parser/documentModel";
import { MAX_SELECTED_SECTIONS } from "../prompts/select";
import type { SourceSection } from "../types";
import type { MapEntry } from "./paperMap";

export type Intent = "ask" | "edit";

export interface Selection {
  intent: Intent;
  entries: MapEntry[];
  focus?: string;
  /** The reply could not be read; the cursor section was used instead. */
  fallback: boolean;
}

/** Characters of section source sent with an answer (roughly 15k tokens). */
const SOURCE_BUDGET = 60_000;
const SECTION_LIMIT = 24_000;

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Read the selector's reply. Unknown keys are dropped; when nothing usable is
 * left the cursor section (if any) is used so the question is still answered.
 */
export function parseSelection(reply: string, entries: MapEntry[], cursorKey?: string): Selection {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const fallback = (): Selection => ({
    intent: "ask",
    entries: cursorKey && byKey.has(cursorKey) ? [byKey.get(cursorKey)!] : [],
    fallback: true,
  });
  const json = firstJsonObject(reply) as { intent?: unknown; sections?: unknown; focus?: unknown } | null;
  if (!json || typeof json !== "object") return fallback();
  const intent: Intent = json.intent === "edit" ? "edit" : "ask";
  const keys = Array.isArray(json.sections) ? json.sections.filter((k): k is string => typeof k === "string") : [];
  const picked = [...new Set(keys)].map((k) => byKey.get(k.trim())).filter((e): e is MapEntry => !!e);
  const focus = typeof json.focus === "string" && json.focus.trim() ? json.focus.trim() : undefined;
  if (picked.length === 0 && intent === "ask") return { ...fallback(), focus };
  return { intent, entries: picked.slice(0, MAX_SELECTED_SECTIONS), focus, fallback: false };
}

/**
 * Source of the selected sections. A section inside another selected section
 * is already part of its parent's source and is skipped.
 */
export function selectedSources(doc: PaperDocument, entries: MapEntry[], files: Map<string, string>): SourceSection[] {
  const kept = entries.filter(
    (e) => !entries.some((o) => o !== e && o.section.startGi <= e.section.startGi && e.section.endGi <= o.section.endGi),
  );
  const out: SourceSection[] = [];
  let used = 0;
  for (const { key, section, label } of kept) {
    const room = Math.min(SECTION_LIMIT, SOURCE_BUDGET - used);
    if (room <= 0) break;
    const text = sectionSource(doc, section, files, room);
    if (!text.trim()) continue;
    out.push({ key, label, text });
    used += text.length;
  }
  return out;
}
