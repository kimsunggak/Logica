/**
 * Paper edit proposals waiting for the author: the text each one replaces is
 * highlighted in the editor, and the highlight moves with every later change.
 * Its range is where the proposal applies, so lines added or removed above it,
 * or the same sentence elsewhere in the file, cannot redirect it.
 */
import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { TargetRange } from "./aiTarget";

/** Highlight one proposal's text (range), or remove its highlight (null). */
export const setPendingEdit = StateEffect.define<{ id: string; range: TargetRange | null }>();
/** Remove every highlight (the conversation was left). */
export const clearPendingEdits = StateEffect.define<null>();
/** Emphasize one proposal while its card is hovered, or none. */
export const focusPendingEdit = StateEffect.define<string | null>();

interface PendingEdits {
  marks: DecorationSet;
  focused: string | null;
}

function mark(id: string, focused: boolean) {
  return Decoration.mark({
    id,
    class: focused ? "cm-pending-edit cm-pending-edit-focused" : "cm-pending-edit",
    attributes: { "data-pending-edit": id },
  });
}

function restyle(marks: DecorationSet, focused: string | null): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const cursor = marks.iter(); cursor.value; cursor.next()) {
    const id = cursor.value.spec.id as string;
    ranges.push(mark(id, id === focused).range(cursor.from, cursor.to));
  }
  return Decoration.set(ranges, true);
}

export const pendingEditsField = StateField.define<PendingEdits>({
  create: () => ({ marks: Decoration.none, focused: null }),
  update(value, tr) {
    // A highlight whose text is deleted entirely disappears with it.
    let marks = value.marks.map(tr.changes);
    let focused = value.focused;
    for (const effect of tr.effects) {
      if (effect.is(clearPendingEdits)) {
        marks = Decoration.none;
      } else if (effect.is(setPendingEdit)) {
        const { id, range } = effect.value;
        marks = marks.update({ filter: (_from, _to, deco) => deco.spec.id !== id });
        if (range && range.to > range.from) marks = marks.update({ add: [mark(id, id === focused).range(range.from, range.to)] });
      } else if (effect.is(focusPendingEdit)) {
        focused = effect.value;
        marks = restyle(marks, focused);
      }
    }
    return marks === value.marks && focused === value.focused ? value : { marks, focused };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
});

/** The text a proposal applies to now, or null when it is not highlighted (its text was removed). */
export function pendingEditRange(state: EditorState, id: string): TargetRange | null {
  const marks = state.field(pendingEditsField, false)?.marks;
  if (!marks) return null;
  for (const cursor = marks.iter(); cursor.value; cursor.next()) {
    if (cursor.value.spec.id === id) return { from: cursor.from, to: cursor.to };
  }
  return null;
}

/** Clicking a highlight scrolls the chat to its proposal card. */
const showCard = EditorView.domEventHandlers({
  click(event) {
    const id = (event.target as Element | null)?.closest?.("[data-pending-edit]")?.getAttribute("data-pending-edit");
    if (!id) return false;
    const card = [...document.querySelectorAll("[data-edit-card]")].find((el) => el.getAttribute("data-edit-card") === id);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return false;
  },
});

export const pendingEdits = [pendingEditsField, showCard];
