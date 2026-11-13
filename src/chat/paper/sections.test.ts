import { describe, expect, it } from "vitest";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { samplePaper, sampleSources } from "../../test/samplePaper";
import { FRONT, paperUnits, preambleOf, textHash, unitText } from "./sections";

const { mainTex, methodTex } = sampleSources;

function unitsOf(files: Map<string, string>) {
  return paperUnits(buildPaperDocument({ files }), files);
}

describe("paperUnits", () => {
  const { units, preamble } = unitsOf(samplePaper());
  const unit = (key: string) => units.find((u) => u.key === key)!;

  it("splits the sample paper into the abstract, sections and subsections, in reading order", () => {
    expect(FRONT).toBe("abstract");
    expect(units.map((u) => u.key)).toEqual(["metadata", FRONT, "1", "1.1", "1.2", "1.3", "2", "2.1", "2.2", "3", "3.1", "3.2", "3.3", "4", "4.1", "4.2", "4.3", "5"]);
    expect(unit(FRONT).title).toBe("Abstract");
    expect(unit("3.2")).toMatchObject({ title: "Uncertainty Estimation", depth: 1, parentKey: "3" });
    expect(unit("3")).toMatchObject({ title: "Method", depth: 0 });
    expect(unit("3").parentKey).toBeUndefined();
    expect(unit("5").title).toBe("Conclusion");
  });

  it("keeps each unit's own text with the file and lines it comes from", () => {
    const routing = unit("3.2");
    expect(routing.sources).toHaveLength(1);
    expect(routing.sources[0]).toMatchObject({ path: "sections/method.tex", fromLine: 9 });
    expect(unitText(routing)).toContain("Gaussian negative log-likelihood");
    expect(unitText(routing)).not.toContain("Temporal Routing");
    expect(routing.labels).toEqual(["sec:uncertainty", "eq:nll"]);
    expect(routing.chars).toBe(unitText(routing).length);
    expect(routing.words).toBeGreaterThan(10);
    // A section's own text stops at its first subsection; its heading is not part of its body.
    expect(unitText(unit("3"))).toBe("\\section{Method}\n\\label{sec:method}\n");
    expect(unit("3").bodyWords).toBe(0);
    expect(routing.bodyWords).toBe(routing.words - 2);
    expect(unit(FRONT).bodyWords).toBe(unit(FRONT).words);
  });

  it("starts the front matter after \\begin{document} and keeps the preamble's class, packages and macros apart", () => {
    const front = unitText(unit(FRONT));
    expect(front).toContain("\\begin{abstract}");
    expect(front).not.toContain("\\usepackage");
    expect(preamble).toBe([
      "\\documentclass[11pt]{article}",
      "\\usepackage[margin=1in]{geometry}",
      "\\usepackage{amsmath,amssymb}",
      "\\usepackage{booktabs}",
      "\\usepackage{natbib}",
      "\\usepackage{hyperref}",
      "\\newcommand{\\method}{\\textsc{STRoute}}",
      "\\newcommand{\\R}{\\mathbb{R}}",
    ].join("\n"));
    // The last section ends before \end{document}.
    expect(unitText(unit("5"))).toContain("\\bibliography{references}");
    expect(unitText(unit("5"))).not.toContain("\\end{document}");
  });

  it("changes only the hash of an edited unit, and keeps hashes when sections are renumbered", () => {
    const files = samplePaper();
    files.set("sections/method.tex", methodTex.replace("keeps the cost low", "keeps the cost very low"));
    const edited = unitsOf(files).units;
    const changed = edited.filter((u, i) => u.hash !== units[i].hash).map((u) => u.key);
    expect(changed).toEqual(["3.3"]);

    const moved = samplePaper();
    moved.set("main.tex", mainTex.replace("\\input{sections/introduction}", "\\section{Background}\nShort.\n\n\\input{sections/introduction}"));
    const renumbered = unitsOf(moved).units;
    expect(renumbered.find((u) => u.title === "Uncertainty Estimation")!.key).toBe("4.2");
    expect(renumbered.find((u) => u.title === "Uncertainty Estimation")!.hash).toBe(unit("3.2").hash);
  });

  it("gives unnumbered headings their own keys", () => {
    const files = new Map([["main.tex", "\\documentclass{article}\n\\begin{document}\nIntro text.\n\\section*{Acknowledgments}\nThanks.\n\\section{Method}\nWe route.\n\\end{document}\n"]]);
    expect(unitsOf(files).units.map((u) => [u.key, u.title])).toEqual([
      [FRONT, "Abstract"],
      ["u1", "Acknowledgments"],
      ["1", "Method"],
    ]);
  });

  it("has no units without a main file", () => {
    expect(unitsOf(new Map([["notes.tex", "Some notes."]])).units).toEqual([]);
  });
});

describe("preambleOf", () => {
  it("keeps definitions with the lines they continue on, without comments", () => {
    const preamble = "\\usepackage{x}\n\\newcommand{\\ours}{%\n  Ours}\n\\title{Not a definition}\n\\def\\eps{\\varepsilon} % small\n\\DeclareMathOperator*{\\argmax}{arg\\,max}";
    expect(preambleOf(preamble)).toBe("\\usepackage{x}\n\\newcommand{\\ours}{\n  Ours}\n\\def\\eps{\\varepsilon}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}");
  });

  it("keeps the class options that set a two-column layout, also across lines", () => {
    const preamble = "\\documentclass[10pt,twocolumn,\n  letterpaper]{article}\n% \\usepackage{cvpr}\n\\usepackage[review]{cvpr}\n\\input{preamble}";
    expect(preambleOf(preamble)).toBe("\\documentclass[10pt,twocolumn,\n  letterpaper]{article}\n\\usepackage[review]{cvpr}");
  });
});

describe("textHash", () => {
  it("is stable and tells texts apart", () => {
    expect(textHash("We route joints.")).toBe(textHash("We route joints."));
    expect(textHash("We route joints.")).not.toBe(textHash("We route joints!"));
    expect(textHash("")).toHaveLength(14);
  });
});
