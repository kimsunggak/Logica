// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterAll, describe, expect, it } from "vitest";
import { editorSession } from "./editorSession";

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
});
