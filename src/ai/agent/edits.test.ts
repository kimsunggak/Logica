import { describe, expect, it } from "vitest";
import { lineOf, locateEdit, parseEditBody } from "./edits";

describe("parseEditBody", () => {
  it("reads original and revised text", () => {
    const edit = parseEditBody("sections/a.tex", "<<<<<<< ORIGINAL\nold line\n=======\nnew line\n>>>>>>> REVISED\n");
    expect(edit).toEqual({ path: "sections/a.tex", original: "old line", revised: "new line" });
  });

  it("allows an empty replacement (deletion) but not an empty original", () => {
    expect(parseEditBody("a.tex", "<<<<<<< ORIGINAL\nold\n=======\n>>>>>>> REVISED")?.revised).toBe("");
    expect(parseEditBody("a.tex", "<<<<<<< ORIGINAL\n=======\nnew\n>>>>>>> REVISED")).toBeNull();
  });

  it("rejects incomplete blocks (still streaming)", () => {
    expect(parseEditBody("a.tex", "<<<<<<< ORIGINAL\nold\n=======\nnew")).toBeNull();
  });
});

describe("locateEdit", () => {
  const text = "First paragraph with \\cite{a}.\n\nSecond paragraph\nwraps here.\n\nFirst paragraph again.";

  it("finds a unique exact match", () => {
    const at = locateEdit(text, "Second paragraph\nwraps here.");
    expect(text.slice(at!.from, at!.to)).toBe("Second paragraph\nwraps here.");
    expect(lineOf(text, at!.from)).toBe(3);
  });

  it("tolerates re-wrapped whitespace", () => {
    const at = locateEdit(text, "Second paragraph wraps   here.");
    expect(text.slice(at!.from, at!.to)).toBe("Second paragraph\nwraps here.");
  });

  it("refuses ambiguous or missing text", () => {
    expect(locateEdit(text, "First paragraph")).toBeNull();
    expect(locateEdit(text, "Third paragraph")).toBeNull();
  });
});
