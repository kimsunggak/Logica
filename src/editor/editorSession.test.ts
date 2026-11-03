// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterAll, describe, expect, it } from "vitest";
import { editorSession } from "./editorSession";
import { focusPendingEdit, pendingEditRange, setPendingEdit } from "./pendingEdits";

// jsdom does not implement layout; CodeMirror's measuring needs these.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();

describe("editorSession", () => {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "" }) });
  editorSession.setBaseExtensions([]);
  editorSession.attach(view);
  afterAll(() => {
    editorSession.detach();
    view.destroy();
  });

  it("keeps edits when the active file is activated again", () => {
    editorSession.open("a.tex", "alpha");
    editorSession.open("b.tex", "beta");
    editorSession.activate("a.tex");
    view.dispatch({ changes: { from: 5, insert: " edited" } });
    editorSession.activate("a.tex");
    expect(view.state.doc.toString()).toBe("alpha edited");
    expect(editorSession.isDirty("a.tex")).toBe(true);
  });

  it("restores each file's state when switching", () => {
    editorSession.activate("b.tex");
    expect(view.state.doc.toString()).toBe("beta");
    editorSession.activate("a.tex");
    expect(view.state.doc.toString()).toBe("alpha edited");
  });

  it("tracks dirty state against the saved text", () => {
    editorSession.markSaved("a.tex");
    expect(editorSession.isDirty("a.tex")).toBe(false);
    editorSession.applyEdit("b.tex", 0, 0, "x");
    expect(editorSession.textOf("b.tex")).toBe("xbeta");
    expect(editorSession.isDirty("b.tex")).toBe(true);
  });

  it("keeps a read-only file unchanged until it is unlocked, while reloads still replace it", () => {
    editorSession.open("legacy.tex", "\uFFFD text", undefined, { readOnly: true });
    expect(editorSession.isReadOnly("legacy.tex")).toBe(true);
    expect(editorSession.applyEdit("legacy.tex", 0, 0, "x")).toBe(false);
    editorSession.activate("legacy.tex");
    expect(view.state.readOnly).toBe(true);
    expect(editorSession.applyEdit("legacy.tex", 0, 0, "x")).toBe(false);
    editorSession.replaceDocument("legacy.tex", "서론 text");
    editorSession.setReadOnly("legacy.tex", false);
    expect(editorSession.applyEdit("legacy.tex", 0, 0, "x")).toBe(true);
    expect(editorSession.textOf("legacy.tex")).toBe("x서론 text");
    // The lock belongs to its file and survives switching files.
    editorSession.setReadOnly("legacy.tex", true);
    editorSession.activate("a.tex");
    expect(view.state.readOnly).toBe(false);
    editorSession.activate("legacy.tex");
    expect(view.state.readOnly).toBe(true);
  });

  it("keeps a highlight on its text through edits above it and reloads, and drops it with its text", () => {
    editorSession.open("hl.tex", "\\section{A}\nSame.\n\\section{B}\nSame.\n");
    editorSession.activate("hl.tex");
    const from = view.state.doc.toString().lastIndexOf("Same.");
    editorSession.dispatchEffects("hl.tex", [setPendingEdit.of({ id: "m:0", range: { from, to: from + 5 } })]);
    view.dispatch({ changes: { from: 0, insert: "% typed\n" } });
    expect(pendingEditRange(view.state, "m:0")).toEqual({ from: from + 8, to: from + 13 });
    // An external reload changes only what changed: the highlight and the cursor stay.
    view.dispatch({ selection: { anchor: from + 10 } });
    editorSession.replaceDocument("hl.tex", "% typed\n\\section{Alpha}\nSame.\n\\section{B}\nSame.\n");
    expect(pendingEditRange(view.state, "m:0")).toEqual({ from: from + 12, to: from + 17 });
    expect(view.state.selection.main.head).toBe(from + 14);
    editorSession.dispatchEffects("hl.tex", [focusPendingEdit.of("m:0")]);
    expect(view.contentDOM.querySelector(".cm-pending-edit-focused")?.textContent).toBe("Same.");
    // Moving to another file and back keeps it.
    editorSession.activate("a.tex");
    editorSession.activate("hl.tex");
    expect(pendingEditRange(view.state, "m:0")).not.toBeNull();
    view.dispatch({ changes: { from: from + 12, to: from + 17 } });
    expect(pendingEditRange(view.state, "m:0")).toBeNull();
  });

  it("resets a file to new, editable text in the active view", () => {
    editorSession.activate("legacy.tex");
    editorSession.resetDocument("legacy.tex", "converted");
    expect(view.state.doc.toString()).toBe("converted");
    expect(editorSession.isReadOnly("legacy.tex")).toBe(false);
    expect(editorSession.isDirty("legacy.tex")).toBe(false);
  });
});
