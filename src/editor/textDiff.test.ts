import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { mapRange, textChanges } from "./textDiff";

const apply = (before: string, after: string) =>
  ChangeSet.of(textChanges(before, after), before.length).apply(Text.of(before.split("\n"))).toString();

describe("minimal text changes", () => {
  it.each([
    ["same", "a\nb\n", "a\nb\n"],
    ["line added above", "one\ntwo\n", "zero\none\ntwo\n"],
    ["word changed in a line", "The quick fox.\nEnd.\n", "The slow fox.\nEnd.\n"],
    ["lines removed", "a\nb\nc\nd\n", "a\nd\n"],
    ["no final newline", "a\nb", "a\nB\nc"],
    ["everything replaced", "old text\n", "new\ncontent\n"],
    ["to empty", "a\nb\n", ""],
    ["from empty", "", "a\nb\n"],
  ])("turns the old text into the new one (%s)", (_case, before, after) => {
    expect(apply(before, after)).toBe(after);
  });

  it("keeps a range on text that did not change", () => {
    const before = "\\section{A}\nSame.\n\\section{B}\nSame.\n";
    const after = "% new line\n" + before.replace("\\section{A}", "\\section{Alpha}");
    const from = before.lastIndexOf("Same.");
    expect(mapRange(before, after, { from, to: from + 5 })).toEqual({ from: after.lastIndexOf("Same."), to: after.lastIndexOf("Same.") + 5 });
    // A range whose text was removed is gone.
    expect(mapRange(before, before.replace("\\section{B}\nSame.\n", ""), { from, to: from + 5 })).toBeNull();
  });
});
