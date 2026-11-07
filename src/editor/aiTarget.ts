/**
 * Briefly highlights a line after navigation.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Briefly highlight a line after navigation. */
export const flashLine = StateEffect.define<number | null>();

export const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(flashLine)) {
        if (effect.value === null) return Decoration.none;
        const line = tr.state.doc.lineAt(effect.value);
        return Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(line.from)]);
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});
