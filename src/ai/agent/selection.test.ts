import { describe, expect, it } from "vitest";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { buildPaperMap } from "./paperMap";
import { parseSelection, selectedSources } from "./selection";

const main = String.raw`\documentclass{article}
\title{Adaptive Routing}
\begin{document}
\begin{abstract}
We propose a routing method.
\end{abstract}
\section{Introduction}
Pose estimation is hard because of \emph{occlusion}.
\section{Method}
\label{sec:method}
Overview text.
\subsection{Routing}
Routing words here.
\section{Experiments}
We test on three datasets.
\end{document}
`;

const files = new Map([["main.tex", main]]);
const doc = buildPaperDocument({ files });
const map = buildPaperMap(doc, files);

describe("buildPaperMap", () => {
  it("lists every section with a key, its number and its opening words", () => {
    expect(map.entries.map((e) => e.key)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(map.text).toContain("title: Adaptive Routing");
    expect(map.text).toContain("abstract: We propose a routing method.");
    expect(map.text).toContain("[s1] 1 Introduction");
    expect(map.text).toContain("Pose estimation is hard because of occlusion.");
    expect(map.text).toContain("  [s3] 2.1 Routing");
    expect(map.entries[2].label).toBe("2 Method › 2.1 Routing");
  });
});

describe("parseSelection", () => {
  it("reads intent, known section keys and the restated question", () => {
    const s = parseSelection('{"intent":"ask","sections":["s4","s9","s1","s4"],"focus":"What data is used?"}', map.entries);
    expect(s.intent).toBe("ask");
    expect(s.entries.map((e) => e.key)).toEqual(["s4", "s1"]);
    expect(s.focus).toBe("What data is used?");
    expect(s.fallback).toBe(false);
  });

  it("accepts JSON wrapped in prose or a code fence", () => {
    const s = parseSelection('Sure:\n```json\n{"intent":"edit","sections":["s2"],"focus":"Shorten it"}\n```', map.entries);
    expect(s.intent).toBe("edit");
    expect(s.entries.map((e) => e.key)).toEqual(["s2"]);
  });

  it("falls back to the cursor section when the reply is unusable", () => {
    const s = parseSelection("I think section 2 is relevant.", map.entries, "s2");
    expect(s).toMatchObject({ intent: "ask", fallback: true });
    expect(s.entries.map((e) => e.key)).toEqual(["s2"]);
  });
});

describe("selectedSources", () => {
  it("sends each section's source once, skipping sections inside another selected one", () => {
    const entries = map.entries.filter((e) => ["s3", "s2"].includes(e.key));
    const sources = selectedSources(doc, entries, files);
    expect(sources.map((s) => s.key)).toEqual(["s2"]);
    expect(sources[0].text).toContain("Overview text.");
    expect(sources[0].text).toContain("Routing words here.");
    expect(sources[0].text).not.toContain("three datasets");
  });
});
