import { describe, expect, it } from "vitest";
import { parseLatexLog } from "./logParser";

const log = String.raw`This is pdfTeX, Version 3.141592653
(./main.tex
LaTeX2e <2023-11-01>
(./sections/method.tex
./sections/method.tex:42: Undefined control sequence.
l.42 We estimate \foo
                     {x}.
?
./main.tex:3: LaTeX Error: File ${"`"}missingpkg.sty' not found.

LaTeX Warning: Citation ${"`"}smith2020' on page 1 undefined on input line 12.

LaTeX Warning: Reference ${"`"}fig:x' on page 2 undefined on input line 30.

Overfull \hbox (1.2pt too wide) in paragraph at lines 3--4
LaTeX Warning: There were undefined references.
`;

describe("parseLatexLog", () => {
  const parsed = parseLatexLog(log, "main.tex");
  it("extracts file:line errors with context", () => {
    expect(parsed.errors[0]).toMatchObject({
      file: "sections/method.tex",
      line: 42,
      message: "Undefined control sequence.",
    });
    expect(parsed.errors[0].context).toContain("\\foo");
  });
  it("detects missing packages", () => {
    expect(parsed.missingPackages).toEqual(["missingpkg.sty"]);
    expect(parsed.errors[1].hint).toContain("tlmgr install missingpkg");
  });
  it("collects undefined citation and reference warnings", () => {
    expect(parsed.warnings.map((w) => w.message)).toEqual([
      'Citation "smith2020" is undefined',
      'Reference "fig:x" is undefined',
    ]);
  });
  it("does not mix TeX help text into the error context", () => {
    const padded = "                       For each joint we predict a mean $\\mu_{t,j}$ and a va...";
    expect(padded.length).toBe(79);
    const help = [
      "./sections/method.tex:10: Undefined control sequence.",
      "l.10 \\undefinedcommand",
      padded,
      "The control sequence at the end of the top line",
      "of your error message was never \\def'ed.",
    ].join("\n");
    const item = parseLatexLog(help, "main.tex").errors[0];
    expect(item.line).toBe(10);
    expect(item.context).toContain("\\undefinedcommand For each joint");
    expect(item.context).not.toContain("The control sequence");
  });
  it("resolves paths relative to the main file directory", () => {
    const nested = parseLatexLog("./intro.tex:5: Missing $ inserted.\nl.5 a_b\n", "paper/main.tex");
    expect(nested.errors[0].file).toBe("paper/intro.tex");
    expect(nested.errors[0].hint).toBeDefined();
  });
});

describe("character hints", () => {
  it("explains Korean text under pdflatex", () => {
    const log = "./main.tex:3: LaTeX Error: Unicode character 한 (U+D55C)\n               not set up for use with LaTeX.\n\nl.3 한\n";
    const parsed = parseLatexLog(log, "main.tex");
    expect(parsed.errors[0].hint).toContain("kotex");
  });
});

describe("missing figure", () => {
  it("explains a figure XeTeX/Tectonic cannot load", () => {
    const log = "! Unable to load picture or PDF file 'figures/routing-framework.pdf'.\n<to be read again>\n}\nl.42 ...ludegraphics[width=\\linewidth]{figures/routing-framework}\n";
    const parsed = parseLatexLog(log, "main.tex");
    expect(parsed.errors[0].message).toContain("figures/routing-framework.pdf");
    expect(parsed.errors[0].hint).toContain("figures/routing-framework.pdf");
    expect(parsed.errors[0].line).toBe(42);
  });
});

describe("overfull lines", () => {
  const log = [
    "(./main.tex",
    "(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls",
    "Document Class: article 2023/05/17 v1.4n Standard LaTeX document class",
    ")",
    "(./sections/experiments.tex",
    "Overfull \\hbox (58.21767pt too wide) in paragraph at lines 20--35",
    "[][] ",
    "[]\\TU/NanumMyeongjo(0)/m/n/9 갱신 방식 (초안 ",
    "",
    "Overfull \\hbox (3.1pt too wide) in paragraph at lines 40--41",
    "[]\\TU/NanumMyeongjo(0)/m/n/10 짧게 넘친 글",
    "",
    "Overfull \\hbox (24.0pt too wide) in alignment at lines 50--60",
    " [] [] ",
    "",
    ")",
    "Overfull \\hbox (12.5pt too wide) detected at line 8",
    "$[]$",
    "",
    "(/usr/share/texlive/texmf-dist/tex/latex/tools/longtable.sty",
    "Overfull \\hbox (30.0pt too wide) in paragraph at lines 1--2",
    "[]",
    "",
    "))",
  ].join("\n");
  const warnings = parseLatexLog(log, "main.tex").warnings;

  it("reports content that runs past the column with its file and line", () => {
    expect(warnings.map((w) => [w.file, w.line])).toEqual([
      ["sections/experiments.tex", 20],
      ["sections/experiments.tex", 50],
      ["main.tex", 8],
      [undefined, undefined],
    ]);
    expect(warnings[0].message).toContain("58pt");
    expect(warnings[0].hint).toContain("table*");
  });

  it("ignores lines that barely touch the margin", () => {
    expect(warnings.map((w) => /(\d+)pt/.exec(w.message)?.[1])).toEqual(["58", "24", "13", "30"]);
  });
});

describe("overfull lines after an error", () => {
  it("does not let a quoted source line change which file is open", () => {
    const log = [
      "(./main.tex",
      "(./sections/method.tex",
      "./sections/method.tex:5: Undefined control sequence.",
      "<argument> \\foo (unclosed",
      "                 ",
      "l.5 \\caption{\\foo (unclosed}",
      "                            ",
      ")",
      "Overfull \\hbox (20.0pt too wide) in paragraph at lines 9--10",
      "[]",
      "",
      ")",
    ].join("\n");
    const parsed = parseLatexLog(log, "main.tex");
    expect(parsed.errors[0]).toMatchObject({ file: "sections/method.tex", line: 5 });
    expect(parsed.warnings[0]).toMatchObject({ file: "main.tex", line: 9 });
  });
});
