import { describe, expect, it } from "vitest";
import type { AIResponse, SourceRange } from "../../ai/types";
import { locateExact, preparePaperEdits, readEditProposal, validEditPath } from "./editTool";

const sources: SourceRange[] = [{ path: "sections/method.tex", fromLine: 4, toLine: 5, text: "A long explanation.\nAnother paragraph." }];
const edit = { path: sources[0].path, original: "A long explanation.", revised: "A concise explanation." };
const response = (edits: unknown): AIResponse => ({
  id: "r", provider: "openai", model: "m", text: "", finishReason: "stop",
  toolCalls: [{ id: "tool-1", name: "apply_paper_edits", arguments: { summary: "Proposed changes.", edits } }],
});

describe("editing tool arguments", () => {
  it("reads a queued tool proposal without applying it", () => {
    expect(readEditProposal(response([edit]), sources)).toEqual({ callId: "tool-1", summary: "Proposed changes.", edits: [{ ...edit, lines: { from: 4, to: 5 } }] });
  });
  it.each(["/tmp/a.tex", "../a.tex", "sections/../a.tex", "C:\\a.tex", "main.bib", "./main.tex", "a//b.tex"])("rejects invalid source path %s", (path) => {
    expect(validEditPath(path)).toBe(false);
    expect(() => readEditProposal(response([{ ...edit, path }]), sources)).toThrow();
  });
  it("requires original text from a selected editable source", () => {
    expect(() => readEditProposal(response([{ ...edit, original: "An invented original." }]), sources)).toThrow();
    expect(() => readEditProposal(response([{ ...edit, path: "other.tex" }]), sources)).toThrow();
  });
  it("supports insertion anchors and deletion", () => {
    expect(readEditProposal(response([{ ...edit, revised: "" }]), sources).edits[0].revised).toBe("");
    expect(readEditProposal(response([{ ...edit, revised: edit.original + " Added sentence." }]), sources).edits[0].revised).toContain("Added sentence.");
  });
  it("rejects partial JSON, multiple tool calls and truncated outputs", () => {
    const invalid = response([edit]);
    invalid.toolCalls![0].argumentsError = "invalid_json";
    expect(() => readEditProposal(invalid, sources)).toThrow();
    expect(() => readEditProposal({ ...response([edit]), finishReason: "length" }, sources)).toThrow();
    expect(() => readEditProposal({ ...response([edit]), toolCalls: [...response([edit]).toolCalls!, ...response([edit]).toolCalls!] }, sources)).toThrow();
  });
});

describe("an anchor that also appears outside its section", () => {
  const file = "\\section{A}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\\section{B}\n\\begin{itemize}\n\\item b\n\\end{itemize}\n";
  const sectionB: SourceRange = { path: "main.tex", fromLine: 5, toLine: 8, text: file.split("\n").slice(4, 8).join("\n") };

  it("applies to the occurrence in the section the model was given", () => {
    const proposal = readEditProposal(response([{ path: "main.tex", original: "\\end{itemize}", revised: "\\item c\n\\end{itemize}" }]), [sectionB]);
    expect(proposal.edits[0].lines).toEqual({ from: 5, to: 8 });
    const [change] = preparePaperEdits(proposal.edits, new Map([["main.tex", file]]))!;
    expect(file.slice(0, change.from) + change.revised + file.slice(change.to)).toBe(file.replace("\\item b\n", "\\item b\n\\item c\n"));
  });
  it("stays ambiguous without the section, or twice inside it", () => {
    expect(locateExact(file, "\\end{itemize}")).toBeNull();
    expect(locateExact(file, "itemize}", { from: 5, to: 8 })).toBeNull();
  });
  it("finds a text unique in the file even after its section moved", () => {
    expect(locateExact(file, "\\item b", { from: 1, to: 2 })).toEqual({ from: file.indexOf("\\item b"), to: file.indexOf("\\item b") + 7 });
  });
});

describe("exact source replacement preflight", () => {
  it("requires one unchanged anchor even after whitespace-only changes", () => {
    expect(locateExact("A  long explanation.", edit.original)).toBeNull();
    expect(locateExact(edit.original + edit.original, edit.original)).toBeNull();
    expect(preparePaperEdits([edit], new Map([[edit.path, "changed source"]]))).toBeNull();
  });
  it("checks every file before preparing a batch", () => {
    const another = { path: "intro.tex", original: "Intro", revised: "New intro" };
    expect(preparePaperEdits([edit, another], new Map([[edit.path, sources[0].text]]))).toBeNull();
  });
  it("rejects overlapping edits in one file", () => {
    expect(preparePaperEdits([edit, { ...edit, original: "long explanation.", revised: "explanation" }], new Map([[edit.path, sources[0].text]]))).toBeNull();
  });
  it("prepares multiple locations and files bottom-up without changing unrelated text", () => {
    const edits = [edit, { ...edit, original: "Another paragraph.", revised: "Another." }, { path: "intro.tex", original: "Intro", revised: "Introduction" }];
    const texts = new Map([[edit.path, "Before\n" + sources[0].text + "\nAfter"], ["intro.tex", "Intro\nBody"]]);
    const prepared = preparePaperEdits(edits, texts)!;
    expect(prepared).toHaveLength(3);
    for (const change of prepared) {
      const text = texts.get(change.path)!;
      texts.set(change.path, text.slice(0, change.from) + change.revised + text.slice(change.to));
    }
    expect(texts.get(edit.path)).toBe("Before\nA concise explanation.\nAnother.\nAfter");
    expect(texts.get("intro.tex")).toBe("Introduction\nBody");
  });
});
