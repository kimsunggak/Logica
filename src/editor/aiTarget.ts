/**
 * Tracks the text range an AI edit applies to. The range is mapped through
 * concurrent document changes and highlighted while the AI edit is open.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface TargetRange {
  from: number;
  to: number;
}

export const setAITarget = StateEffect.define<TargetRange | null>();

const targetMark = Decoration.mark({ class: "cm-ai-target" });

export const aiTargetField = StateField.define<TargetRange | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setAITarget)) return effect.value;
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      return to >= from ? { from, to } : null;
    }
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (range): DecorationSet =>
      range && range.to > range.from ? Decoration.set([targetMark.range(range.from, range.to)]) : Decoration.none,
    ),
});

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
