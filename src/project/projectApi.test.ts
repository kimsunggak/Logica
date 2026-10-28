import { EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readEditProposal, preparePaperEdits } from "../chat/paper/editTool";
import { paperUnits } from "../chat/paper/sections";
import { buildPaperDocument } from "../latex/parser/documentModel";
import type { AIResponse } from "../ai/types";
import { call } from "../lib/backend";
import { readTextFile } from "./projectApi";

vi.mock("../lib/backend", () => ({ call: vi.fn() }));

const ROOT = "/papers/example";
const PATH = "main.tex";
const source = "\\documentclass{article}\n\\begin{document}\n\\section{Method}\nFirst sentence.\nSecond sentence.\n\\end{document}\n";
const rawFile = (content: string) => ({ content, mtime: 123, lossy: false });

beforeEach(() => { vi.mocked(call).mockReset(); });

describe("readTextFile line endings", () => {
  it.each([
    ["CRLF", "First line.\r\nSecond line.\r\n"],
    ["CR", "First line.\rSecond line.\r"],
    ["LF", "First line.\nSecond line.\n"],
    ["mixed", "First line.\r\nSecond line.\r"],
  ])("reads %s as LF while preserving file metadata and IPC arguments", async (_kind, content) => {
    const file = { ...rawFile(content), mtime: 0, lossy: true };
    vi.mocked(call).mockResolvedValue(file);
    expect(await readTextFile(ROOT, PATH)).toEqual({ content: "First line.\nSecond line.\n", mtime: 0, lossy: true });
    expect(call).toHaveBeenCalledExactlyOnceWith("read_text_file", { root: ROOT, path: PATH });
    // Normalization changes only the app's returned text, not the backend result.
    expect(file.content).toBe(content);
  });

  it("preserves read failures", async () => {
    const failure = { kind: "not_found", message: "Missing source" };
    vi.mocked(call).mockRejectedValue(failure);
    await expect(readTextFile(ROOT, PATH)).rejects.toBe(failure);
  });

  it("keeps a multiline edit valid when an unopened CRLF file is opened in CodeMirror", async () => {
    vi.mocked(call).mockResolvedValue(rawFile(source.replace(/\n/g, "\r\n")));
    const file = await readTextFile(ROOT, PATH);
    const files = new Map([[PATH, file.content]]);
    const { units } = paperUnits(buildPaperDocument({ files, mainFile: PATH }), files);
    const sources = units.find((unit) => unit.key === "1")!.sources;
    const edit = { path: PATH, original: "First sentence.\nSecond sentence.", revised: "Revised first.\nRevised second." };
    const response: AIResponse = {
      id: "response", provider: "openai", model: "model", text: "", finishReason: "stop",
      toolCalls: [{ id: "edit-call", name: "apply_paper_edits", arguments: { summary: "Proposed changes", edits: [edit] } }],
    };
    const proposal = readEditProposal(response, sources);
    const opened = EditorState.create({ doc: file.content });
    const replacements = preparePaperEdits(proposal.edits, new Map([[PATH, opened.doc.toString()]]));
    expect(replacements).not.toBeNull();
    const replacement = replacements![0];
    const applied = opened.update({ changes: { from: replacement.from, to: replacement.to, insert: replacement.revised } }).state;
    expect(applied.doc.toString()).toBe(source.replace(edit.original, edit.revised));
    // Whitespace edits by the author are still detected by exact matching.
    expect(preparePaperEdits(proposal.edits, new Map([[PATH, file.content.replace("First sentence.", "First  sentence.")]]))).toBeNull();
  });

  it.each(["\r\n", "\r"])("keeps section hashes stable when a %j file is opened", async (ending) => {
    vi.mocked(call).mockResolvedValue(rawFile(source.replace(/\n/g, ending)));
    const file = await readTextFile(ROOT, PATH);
    const files = new Map([[PATH, file.content]]);
    const before = paperUnits(buildPaperDocument({ files, mainFile: PATH }), files).units;
    const openedFiles = new Map([[PATH, EditorState.create({ doc: file.content }).doc.toString()]]);
    const after = paperUnits(buildPaperDocument({ files: openedFiles, mainFile: PATH }), openedFiles).units;
    expect(before.length).toBeGreaterThan(0);
    expect(after.map((unit) => [unit.key, unit.hash])).toEqual(before.map((unit) => [unit.key, unit.hash]));
  });
});
