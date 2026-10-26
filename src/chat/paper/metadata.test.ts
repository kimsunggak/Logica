import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import blank from "../../../src-tauri/templates/blank/main.tex?raw";
import cvpr from "../../../src-tauri/templates/cvpr/main.tex?raw";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { editableSources, preparePaperEdits, readEditProposal, requireFullSections } from "./editTool";
import { METADATA } from "./metadata";
import { emptyReport, hasSummaries, readReportYaml, reportYaml, summariesFor, unitsToSummarize, withSummaries } from "./report";
import { paperMap, paperRequest, resolveScope, type Paper } from "./scope";
import { summarizeSections } from "./sectionSummarizer";
import { FRONT, paperUnits, unitText } from "./sections";
import type { AIResponse } from "../../ai/types";

const title = "\\title[Short]{A \\emph{long}\n  paper title}";
const author = "\\author{Ada \\thanks{Support} \\and\n  Bob}";
const base = [
  "\\documentclass{article}", "\\usepackage{x} " + title, author, "\\begin{document}",
  "\\maketitle", "\\begin{abstract}", "An abstract.", "\\end{abstract}", "\\section{Method}",
  "First sentence.", "Second sentence.", "\\end{document}",
].join("\n");
function paperOf(files = new Map([["main.tex", base]])): Paper {
  const document = buildPaperDocument({ files, mainFile: "main.tex" });
  const parsed = paperUnits(document, files);
  return { ...parsed, files: document.files.filter((f) => f.included && !f.missing).map((f) => ({ path: f.path, text: files.get(f.path)! })), omitted: [], budget: 150000, summaries: summariesFor(parsed.units, emptyReport()) };
}
const proposal = (path: string, original: string, revised: string): AIResponse => ({
  id: "response", provider: "openai", model: "m", text: "", finishReason: "stop",
  toolCalls: [{ id: "tool", name: "apply_paper_edits", arguments: { summary: "Proposed change", edits: [{ path, original, revised }] } }],
});

describe("selectable paper metadata", () => {
  it("extracts multiline title/author declarations without exposing neighboring preamble commands", () => {
    const paper = paperOf();
    const metadata = paper.units!.find((u) => u.key === METADATA)!;
    expect(metadata).toMatchObject({ title: "Title and Authors", depth: 0, summary: "Title: A long paper title\nAuthors: Ada Bob" });
    expect(metadata.sources.map((s) => s.text)).toEqual([title, author]);
    expect(metadata.sources[0]).toMatchObject({ path: "main.tex", fromLine: 2, toLine: 3 });
    expect(unitText(metadata)).not.toContain("\\usepackage");
    expect(unitText(paper.units!.find((u) => u.key === FRONT)!)).not.toContain("\\title");
    expect(paperMap(paper)![0]).toMatchObject({ key: METADATA, summary: metadata.summary });
  });

  it("keeps only declarations in included files and ignores comments, escaped commands and macro bodies", () => {
    const files = new Map([
      ["main.tex", "\\documentclass{article}\n\\newcommand{\\unused}{\\title{Fake macro title}}\n% \\author{Comment}\n\\\\author{Escaped}\n\\input{fields}\n\\begin{document}\n\\maketitle\n\\section{Method}\nBody.\n\\end{document}"],
      ["fields.tex", "\\title{Included title}\n\\author{Included author}"],
      ["draft.tex", "\\title{Unused draft}\n\\author{Unused author}"],
    ]);
    const metadata = paperOf(files).units!.find((u) => u.key === METADATA)!;
    expect(metadata.summary).toBe("Title: Included title\nAuthors: Included author");
    expect(metadata.sources.map((s) => s.path)).toEqual(["fields.tex", "fields.tex"]);
  });

  it.each([["blank", blank], ["cvpr", cvpr]])("makes the %s template's real declarations writable", (_name, text) => {
    const paper = paperOf(new Map([["main.tex", text], ["preamble.tex", ""]]));
    const metadata = paper.units!.find((u) => u.key === METADATA)!;
    expect(metadata.sources.some((s) => s.text.startsWith("\\title"))).toBe(true);
    expect(metadata.sources.some((s) => s.text.startsWith("\\author"))).toBe(true);
    for (const source of metadata.sources) {
      expect(readEditProposal(proposal(source.path, source.text, source.text + " "), editableSources(paper, [METADATA])).edits).toHaveLength(1);
    }
  });

  it("preserves unresolved macro values and ignores declarations after the document ends", () => {
    const paper = paperOf(new Map([["main.tex", base.replace(title, "\\title{\\paperTitle}") + "\n\\title{Ignored title}\n\\author{Ignored author}"]]));
    const metadata = paper.units!.find((u) => u.key === METADATA)!;
    expect(metadata.summary).toBe("Title: \\paperTitle\nAuthors: Ada Bob");
    expect(metadata.sources).toHaveLength(2);
  });

  it("keeps title/author commands before end{document} on the same physical line", () => {
    const compact = "\\documentclass{article}\n\\title{Real Title}\\author{Real Author}\\begin{document}\\maketitle\\end{document}\\title{Ignored}";
    const metadata = paperOf(new Map([["main.tex", compact]])).units!.find((u) => u.key === METADATA)!;
    expect(metadata.summary).toBe("Title: Real Title\nAuthors: Real Author");
    expect(metadata.sources.map((s) => s.text)).toEqual(["\\title{Real Title}", "\\author{Real Author}"]);
  });

  it("permits metadata edits with their full declarations and keeps other full references read-only", () => {
    const paper = paperOf();
    const report = withSummaries(emptyReport(), paper.units!.filter((u) => u.key !== METADATA).map((u) => ({ hash: u.hash, title: u.title, summary: "Body summary." })), paper.units!);
    paper.summaries = summariesFor(paper.units!, report);
    const scope = resolveScope(paper, [METADATA, "1"]);
    requireFullSections(paper, scope, [METADATA, "1"]);
    const request = paperRequest(paper, scope);
    expect("paperView" in request && request.paperView.sections.find((s) => s.key === METADATA)?.content).toBe("full");
    const edits = readEditProposal(proposal("main.tex", title, "\\title{New title}"), editableSources(paper, [METADATA])).edits;
    expect(preparePaperEdits(edits, new Map([["main.tex", base]]))).not.toBeNull();
    expect(() => readEditProposal(proposal("main.tex", "First sentence.", "Changed."), editableSources(paper, [METADATA]))).toThrow();
    expect(() => readEditProposal(proposal("main.tex", "\\usepackage{x}", "\\usepackage{y}"), editableSources(paper, [METADATA]))).toThrow();
  });

  it("lets all edit every full file including preamble, while still requiring omitted files to be read", () => {
    const paper = paperOf();
    const scope = resolveScope(paper, ["all"]);
    requireFullSections(paper, scope, ["all"]);
    expect(editableSources(paper, ["all"])).toHaveLength(1);
    expect(readEditProposal(proposal("main.tex", "\\usepackage{x}", "\\usepackage{y}"), editableSources(paper, ["all"])).edits).toHaveLength(1);
    expect(() => requireFullSections({ ...paper, omitted: ["large.tex"] }, scope, ["all"])).toThrow();
  });

  it("refreshes only metadata after a preamble title/author edit and preserves cached body summaries", () => {
    const paper = paperOf();
    const old = withSummaries(emptyReport(), paper.units!.filter((u) => u.key !== METADATA).map((u) => ({ hash: u.hash, title: u.title, summary: "Cached body." })), paper.units!);
    const changed = paperOf(new Map([["main.tex", base.replace(title, "\\title{Changed}").replace(author, "\\author{Carol}")]]));
    expect(changed.units!.filter((u, i) => u.hash !== paper.units![i].hash).map((u) => u.key)).toEqual([METADATA]);
    expect(unitsToSummarize(changed.units!, old).map((u) => u.key)).toEqual([METADATA]);
    expect(summariesFor(changed.units!, old).get(METADATA)).toBe("Title: Changed\nAuthors: Carol");
    const next = withSummaries(old, [], changed.units!);
    const yaml = parse(reportYaml(next, changed.units!, "Changed"));
    expect(yaml.sections[0]).toMatchObject({ key: METADATA, summary: "Title: Changed\nAuthors: Carol" });
    expect(readReportYaml(reportYaml(next, changed.units!))).toEqual(next);
  });

  it("never sends metadata to an LLM or treats metadata alone as body initialization", async () => {
    const paper = paperOf();
    const metadata = paper.units![0];
    const report = withSummaries(emptyReport(), [], paper.units!);
    expect(hasSummaries(paper.units!, report)).toBe(false);
    expect(resolveScope({ ...paper, summaries: summariesFor(paper.units!, report) }, ["1"]).kind).toBe("full");
    const call = vi.fn();
    const result = await summarizeSections([metadata], { traceId: "metadata", control: { stopped: false, activeRequest: null }, call });
    expect(call).not.toHaveBeenCalled();
    expect(result.summarized[0]).toMatchObject({ key: METADATA, summary: metadata.summary });
    // A long author list also stays deterministic.
    await summarizeSections([{ ...metadata, bodyWords: 100 }], { traceId: "metadata-long", control: { stopped: false, activeRequest: null }, call });
    expect(call).not.toHaveBeenCalled();
  });

  it("supplies its code summary even if a caller's summary map contains only body entries", () => {
    const paper = paperOf();
    paper.summaries = new Map(paper.units!.filter((u) => u.key !== METADATA).map((u) => [u.key, "Cached body."]));
    const scope = resolveScope(paper, ["1"]);
    expect(scope.summarized).toContain(METADATA);
    const request = paperRequest(paper, scope);
    expect("paperView" in request && request.paperView.sections[0]).toMatchObject({ content: "summary", summary: "Title: A long paper title\nAuthors: Ada Bob" });
  });

  it("removes deleted metadata from the saved document without invalidating the body's hashes", () => {
    const paper = paperOf();
    const old = withSummaries(emptyReport(), paper.units!.filter((u) => u.key !== METADATA).map((u) => ({ hash: u.hash, title: u.title, summary: "Cached body." })), paper.units!);
    const changed = paperOf(new Map([["main.tex", base.replace(title, "").replace(author, "")]]));
    expect(changed.units!.some((u) => u.key === METADATA)).toBe(false);
    expect(unitsToSummarize(changed.units!, old)).toEqual([]);
    const next = withSummaries(old, [], changed.units!);
    expect(Object.keys(next.summaries)).toHaveLength(Object.keys(old.summaries).length - 1);
    expect(parse(reportYaml(next, changed.units!)).sections.some((entry: { key: string }) => entry.key === METADATA)).toBe(false);
  });
});
