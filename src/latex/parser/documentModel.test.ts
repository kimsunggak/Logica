import { describe, expect, it } from "vitest";
import { buildPaperDocument, detectMainFile, outlineText, sectionAt, sectionSource, sectionTrail } from "./documentModel";
import { keyAtOffset } from "./parseFile";

const main = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Adaptive Spatiotemporal \textbf{Routing}\thanks{Funded.}}
\begin{document}
\maketitle
\begin{abstract}
We propose a routing method. % secret comment
\end{abstract}
\input{sections/introduction}
\include{sections/method}
\input{sections/missing}
% \section{Commented out}
\appendix
\section{Proofs}
Proof text here.
\bibliography{references}
\end{document}
`;

const intro = String.raw`\section{Introduction}
Pose estimation is hard.
\subsection{Motivation}
Occlusion hurts accuracy \cite{vaswani2017attention}.

\subsection*{Contributions}
We contribute things, see Fig.~\ref{fig:overview}.
`;

const method = String.raw`\section[Method]{Our Method}
\label{sec:method}
Overview text.
\subsection{Uncertainty Estimation}
\label{fig:overview}
We estimate $\sigma$.
\subsubsection{Temporal Routing}
Routing words here.
`;

function files() {
  return new Map([
    ["main.tex", main],
    ["sections/introduction.tex", intro],
    ["sections/method.tex", method],
    ["orphan.tex", "\\section{Orphan}\nText"],
  ]);
}

describe("buildPaperDocument", () => {
  const doc = buildPaperDocument({ files: files() });

  it("detects the main file, title and abstract", () => {
    expect(doc.mainFile).toBe("main.tex");
    expect(doc.title).toBe("Adaptive Spatiotemporal Routing");
    expect(doc.abstract).toBe("We propose a routing method.");
  });

  it("builds the section tree in reading order across \\input and \\include", () => {
    expect(doc.sections.map((s) => s.title)).toEqual(["Introduction", "Our Method", "Proofs"]);
    const intro = doc.sections[0];
    expect(intro.filePath).toBe("sections/introduction.tex");
    expect(intro.children.map((c) => c.title)).toEqual(["Motivation", "Contributions"]);
    expect(intro.children[1].starred).toBe(true);
    expect(intro.children[1].number).toBeUndefined();
    const methodSection = doc.sections[1];
    expect(methodSection.number).toBe("2");
    expect(methodSection.children[0].number).toBe("2.1");
    expect(methodSection.children[0].children[0].number).toBe("2.1.1");
    expect(doc.sections[2].number).toBe("A");
  });

  it("ignores commented-out headings", () => {
    expect(doc.flatSections.some((s) => s.title === "Commented out")).toBe(false);
  });

  it("reports missing includes without failing", () => {
    expect(doc.files.find((f) => f.path === "sections/missing.tex")?.missing).toBe(true);
    expect(doc.issues.some((i) => i.message.includes("sections/missing.tex"))).toBe(true);
    expect(doc.files.find((f) => f.path === "orphan.tex")?.included).toBe(false);
  });

  it("counts words per section", () => {
    const motivation = doc.flatSections.find((s) => s.title === "Motivation")!;
    // "Motivation" + "Occlusion hurts accuracy" (citation keys are not words)
    expect(motivation.wordCount).toBe(4);
    expect(doc.sections[0].wordCount).toBeGreaterThan(motivation.wordCount);
  });

  it("finds the innermost section at a position", () => {
    expect(sectionAt(doc, "sections/method.tex", 8)?.title).toBe("Temporal Routing");
    expect(sectionAt(doc, "sections/method.tex", 3)?.title).toBe("Our Method");
    expect(sectionAt(doc, "main.tex", 7)).toBeNull();
    expect(sectionAt(doc, "orphan.tex", 2)?.title).toBe("Orphan");
    const s = sectionAt(doc, "sections/method.tex", 8)!;
    expect(sectionTrail(doc, s)).toBe("2 Our Method › 2.1 Uncertainty Estimation › 2.1.1 Temporal Routing");
  });

  it("collects labels, refs and bibliography files", () => {
    expect(doc.labels.map((l) => l.key)).toContain("sec:method");
    expect(doc.refs.map((r) => r.key)).toContain("fig:overview");
    expect(doc.bibFiles).toEqual(["references.bib"]);
  });

  it("produces outline text and section source", () => {
    expect(outlineText(doc)).toContain("2.1 Uncertainty Estimation");
    const source = sectionSource(doc, doc.sections[1], files());
    expect(source).toContain("Overview text.");
    expect(source).toContain("Routing words here.");
    expect(source).not.toContain("Proofs");
  });

  it("survives malformed LaTeX", () => {
    const broken = buildPaperDocument({
      files: new Map([["main.tex", "\\documentclass{article}\\begin{document}\\section{Unclosed\n\\subsection{Ok}\n\\input{"]]),
    });
    expect(broken.flatSections.map((s) => s.title)).toContain("Ok");
  });
});

describe("detectMainFile", () => {
  it("falls back to a file with documentclass", () => {
    const f = new Map([
      ["a/chapter.tex", "\\section{x}"],
      ["paper.tex", "\\documentclass{article}\\begin{document}\\end{document}"],
    ]);
    expect(detectMainFile(f)).toBe("paper.tex");
  });
});

describe("keyAtOffset", () => {
  it("returns the key under the cursor", () => {
    const text = "see \\cite{a,bb} and \\ref{fig:x}";
    expect(keyAtOffset(text, text.indexOf("bb") + 1)).toEqual({ command: "cite", key: "bb" });
    expect(keyAtOffset(text, text.indexOf("fig:x"))).toEqual({ command: "ref", key: "fig:x" });
    expect(keyAtOffset(text, 1)).toBeNull();
  });
});
