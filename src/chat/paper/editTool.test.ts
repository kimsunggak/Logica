import { describe, expect, it } from "vitest";
import type { AIResponse, SourceRange } from "../../ai/types";
import { t } from "../../i18n";
import { EditProposalError, locateExact, preparePaperEdits, readEditProposal, validEditPath, type EditRejection } from "./editTool";
import { textHash } from "./sections";

const sources: SourceRange[] = [{ path: "sections/method.tex", fromLine: 4, toLine: 5, text: "A long explanation.\nAnother paragraph." }];
const edit = { path: sources[0].path, original: "A long explanation.", revised: "A concise explanation." };
const response = (edits: unknown): AIResponse => ({
  id: "r", provider: "openai", model: "m", text: "", finishReason: "stop",
  toolCalls: [{ id: "tool-1", name: "apply_paper_edits", arguments: { summary: "Proposed changes.", edits } }],
});

/** The check a proposal failed, as `readEditProposal` reports it. */
function rejectionOf(read: () => unknown): EditRejection {
  try {
    read();
  } catch (err) {
    if (err instanceof EditProposalError) return err.rejection;
    throw err;
  }
  throw new Error("The proposal was accepted.");
}

describe("editing tool arguments", () => {
  it("reads a queued tool proposal without applying it", () => {
    expect(readEditProposal(response([edit]), sources)).toEqual({ callId: "tool-1", summary: "Proposed changes.", edits: [edit] });
  });
  it.each(["/tmp/a.tex", "../a.tex", "sections/../a.tex", "C:\\a.tex", "main.bib", "./main.tex", "a//b.tex"])("rejects invalid source path %s", (path) => {
    expect(validEditPath(path)).toBe(false);
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, path }]), sources))).toEqual({ reason: "path", edit: 1, path });
  });
  it("requires original text from a selected editable source", () => {
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, original: "An invented original." }]), sources))).toEqual({
      reason: "not_found", edit: 1, path: edit.path, original: "An invented original.",
    });
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, path: "other.tex" }]), sources))).toMatchObject({ reason: "not_found", path: "other.tex" });
  });
  it("keeps the web evidence ids each edit names, and only the ones it was given", () => {
    const proposal = readEditProposal(response([{ ...edit, evidence: ["W2", "W9", "W2", 3] }]), sources, undefined, ["W1", "W2"]);
    expect(proposal.edits[0].evidence).toEqual(["W2"]);
    expect(readEditProposal(response([{ ...edit, evidence: [] }]), sources, undefined, ["W1"]).edits[0]).not.toHaveProperty("evidence");
    expect(readEditProposal(response([{ ...edit, evidence: ["W1"] }]), sources).edits[0]).not.toHaveProperty("evidence");
  });
  it("supports insertion anchors and deletion", () => {
    expect(readEditProposal(response([{ ...edit, revised: "" }]), sources).edits[0].revised).toBe("");
    expect(readEditProposal(response([{ ...edit, revised: edit.original + " Added sentence." }]), sources).edits[0].revised).toContain("Added sentence.");
  });
  it("rejects partial JSON, multiple tool calls and truncated outputs", () => {
    const invalid = response([edit]);
    invalid.toolCalls![0].argumentsError = "invalid_json";
    expect(rejectionOf(() => readEditProposal(invalid, sources))).toEqual({ reason: "arguments" });
    expect(rejectionOf(() => readEditProposal({ ...response([edit]), finishReason: "length" }, sources))).toEqual({ reason: "incomplete" });
    const twice = { ...response([edit]), toolCalls: [...response([edit]).toolCalls!, { id: "tool-2", name: "clarify_request", arguments: {} }] };
    expect(rejectionOf(() => readEditProposal(twice, sources))).toEqual({ reason: "tool_calls", toolCalls: ["apply_paper_edits", "clarify_request"] });
  });
});

describe("why a proposal is rejected", () => {
  it("keeps what the model wrote when it answered without the tool", () => {
    const text = "Section 4 has no blank lines to remove.";
    expect(rejectionOf(() => readEditProposal({ ...response([edit]), text, toolCalls: [] }, sources))).toEqual({ reason: "no_tool_call", text });
  });
  it("names a missing summary and an empty edit list", () => {
    const empty = (args: Record<string, unknown>): AIResponse => ({ ...response([edit]), toolCalls: [{ id: "tool-1", name: "apply_paper_edits", arguments: args }] });
    expect(rejectionOf(() => readEditProposal(empty({ summary: " ", edits: [edit] }), sources))).toEqual({ reason: "summary" });
    expect(rejectionOf(() => readEditProposal(empty({ summary: "Nothing to change.", edits: [] }), sources))).toEqual({ reason: "no_edits" });
  });
  it("names the edit that is malformed, blank or unchanged", () => {
    expect(rejectionOf(() => readEditProposal(response([edit, "not an edit"]), sources))).toEqual({ reason: "shape", edit: 2 });
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, original: "\n\n  \n" }]), sources))).toMatchObject({ reason: "blank", edit: 1 });
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, revised: edit.original }]), sources))).toMatchObject({ reason: "unchanged", edit: 1 });
  });
  it("tells an original that differs only in blank lines from one that is not there", () => {
    const blankLines = { ...edit, original: "A long explanation.\n\n\nAnother paragraph.", revised: "A long explanation.\nAnother paragraph." };
    expect(rejectionOf(() => readEditProposal(response([blankLines]), sources))).toEqual({ reason: "whitespace", edit: 1, path: edit.path, original: blankLines.original });
  });
  it("tells an original outside the sections being edited, or in them twice", () => {
    const file = "Read-only intro.\nA long explanation.\nAnother paragraph.";
    const texts = new Map([[edit.path, file]]);
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, original: "Read-only intro." }]), sources, texts))).toMatchObject({ reason: "outside", edit: 1 });
    const repeated: SourceRange[] = [{ ...sources[0], text: "Same line.\nSame line." }];
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, original: "Same line." }]), repeated))).toMatchObject({ reason: "ambiguous", edit: 1 });
  });
  it("shows the author which check failed", () => {
    const err = (() => {
      try {
        readEditProposal(response([{ ...edit, original: "An invented original." }]), sources);
      } catch (e) {
        return e as EditProposalError;
      }
    })()!;
    expect(err).toMatchObject({ kind: "malformed_response" });
    expect(err.message).toBe(t("chat.invalidEdits", { reason: t("edits.reject.notFound", { n: 1, path: edit.path }) }));
  });
  it("shortens a long original in the rejection", () => {
    const original = "x".repeat(1000);
    expect(rejectionOf(() => readEditProposal(response([{ ...edit, original }]), sources)).original).toBe(`${"x".repeat(300)}…`);
  });
});

describe("a sentence that also appears in another section", () => {
  const file = "\\section{A}\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\\section{B}\n\\begin{itemize}\n\\item b\n\\end{itemize}\n";
  const sectionB: SourceRange = { path: "main.tex", fromLine: 5, toLine: 8, text: file.split("\n").slice(4, 8).join("\n") };
  const proposed = { path: "main.tex", original: "\\end{itemize}", revised: "\\item c\n\\end{itemize}" };

  it("is placed in the file where the model read it", () => {
    const [placed] = readEditProposal(response([proposed]), [sectionB], new Map([["main.tex", file]])).edits;
    const from = file.lastIndexOf("\\end{itemize}");
    expect(placed.anchor).toEqual({ from, to: from + proposed.original.length, hash: textHash(file) });
  });
  it("applies at its range, and only while that range still holds it", () => {
    const from = file.lastIndexOf("\\end{itemize}");
    const range = { from, to: from + proposed.original.length };
    const [change] = preparePaperEdits([proposed], new Map([["main.tex", file]]), [range])!;
    expect(file.slice(0, change.from) + change.revised + file.slice(change.to)).toBe(file.replace("\\item b\n", "\\item b\n\\item c\n"));
    expect(preparePaperEdits([proposed], new Map([["main.tex", file]]), [{ from: 0, to: proposed.original.length }])).toBeNull();
    expect(preparePaperEdits([proposed], new Map([["main.tex", file]]), [null])).toBeNull();
    // Without a range the sentence is ambiguous, as before.
    expect(preparePaperEdits([proposed], new Map([["main.tex", file]]))).toBeNull();
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
