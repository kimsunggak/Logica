import { describe, expect, it } from "vitest";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { samplePaper, sampleSources } from "../../test/samplePaper";
import { FRONT, macrosOf, paperUnits, textHash, unitText } from "./sections";

const { mainTex, methodTex } = sampleSources;

function unitsOf(files: Map<string, string>) {
  return paperUnits(buildPaperDocument({ files }), files);
}

describe("paperUnits", () => {
  const { units, macros } = unitsOf(samplePaper());
  const unit = (key: string) => units.find((u) => u.key === key)!;

  it("splits the sample paper into the front matter, sections and subsections, in reading order", () => {
    expect(units.map((u) => u.key)).toEqual([FRONT, "1", "1.1", "1.2", "1.3", "2", "2.1", "2.2", "3", "3.1", "3.2", "3.3", "4", "4.1", "4.2", "4.3", "5"]);
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
    // A section's own text stops at its first subsection.
    expect(unitText(unit("3"))).toBe("\\section{Method}\n\\label{sec:method}\n");
  });

  it("starts the front matter after \\begin{document} and keeps only the preamble's macros", () => {
    const front = unitText(unit(FRONT));
    expect(front).toContain("\\begin{abstract}");
    expect(front).not.toContain("\\usepackage");
    expect(macros).toBe("\\newcommand{\\method}{\\textsc{STRoute}}\n\\newcommand{\\R}{\\mathbb{R}}");
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
      [FRONT, "Title and abstract"],
      ["u1", "Acknowledgments"],
      ["1", "Method"],
    ]);
  });

  it("has no units without a main file", () => {
    expect(unitsOf(new Map([["notes.tex", "Some notes."]])).units).toEqual([]);
  });
});

describe("macrosOf", () => {
  it("keeps definitions with the lines they continue on, without comments", () => {
    const preamble = "\\usepackage{x}\n\\newcommand{\\ours}{%\n  Ours}\n\\def\\eps{\\varepsilon} % small\n\\DeclareMathOperator*{\\argmax}{arg\\,max}";
    expect(macrosOf(preamble)).toBe("\\newcommand{\\ours}{\n  Ours}\n\\def\\eps{\\varepsilon}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}");
  });
});

describe("textHash", () => {
  it("is stable and tells texts apart", () => {
    expect(textHash("We route joints.")).toBe(textHash("We route joints."));
    expect(textHash("We route joints.")).not.toBe(textHash("We route joints!"));
    expect(textHash("")).toHaveLength(14);
  });
});
