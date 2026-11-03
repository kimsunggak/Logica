/**
 * Minimal changes between two versions of a text, so that a reload keeps
 * the cursor, the history and every highlight on the text that did not change.
 */
import { ChangeSet } from "@codemirror/state";
import { diffChars, diffLines } from "diff";
import type { TargetRange } from "./aiTarget";

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Changed regions up to this size are compared character by character; larger ones are replaced whole. */
const CHAR_DIFF_LIMIT = 4_000;

/** Changes, in `before`'s positions, that turn `before` into `after`: by line, then by character inside small changes. */
export function textChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const changes: TextChange[] = [];
  const parts = diffLines(before, after);
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].added && !parts[i].removed) {
      pos += parts[i].value.length;
      continue;
    }
    let removed = "";
    let added = "";
    for (; i < parts.length && (parts[i].added || parts[i].removed); i++) {
      if (parts[i].removed) removed += parts[i].value;
      else added += parts[i].value;
    }
    i--;
    if (removed && added && removed.length + added.length <= CHAR_DIFF_LIMIT) {
      const chars = diffChars(removed, added);
      let at = pos;
      for (let j = 0; j < chars.length; j++) {
        const part = chars[j];
        if (!part.added && !part.removed) {
          at += part.value.length;
          continue;
        }
        const deleted = part.removed ? part.value : "";
        const insert = part.added ? part.value : chars[j + 1]?.added ? chars[++j].value : "";
        changes.push({ from: at, to: at + deleted.length, insert });
        at += deleted.length;
      }
    } else {
      changes.push({ from: pos, to: pos + removed.length, insert: added });
    }
    pos += removed.length;
  }
  return changes;
}

/** Where a range of `before` is in `after`, or null when its text was removed. */
export function mapRange(before: string, after: string, range: TargetRange): TargetRange | null {
  if (before === after) return range;
  const changes = ChangeSet.of(textChanges(before, after), before.length);
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  return to > from ? { from, to } : null;
}
