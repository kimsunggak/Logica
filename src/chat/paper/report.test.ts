import { describe, expect, it } from "vitest";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { samplePaper } from "../../test/samplePaper";
import { emptyReport, readReport, REPORT_VERSION, summariesFor, unitsToSummarize, withSummaries } from "./report";
import { FRONT, paperUnits } from "./sections";

const files = samplePaper();
const { units } = paperUnits(buildPaperDocument({ files }), files);
const unit = (key: string) => units.find((u) => u.key === key)!;

describe("paper report", () => {
  it("finds summaries by the unit's hash and never summarizes the front matter", () => {
    expect(unitsToSummarize(units, emptyReport()).map((u) => u.key)).not.toContain(FRONT);
    expect(unitsToSummarize(units, emptyReport())).toHaveLength(units.length - 1);
    const report = withSummaries(emptyReport(), [{ hash: unit("3.2").hash, title: "Uncertainty Estimation", summary: "Predicts a variance per joint." }], units, 5);
    expect(summariesFor(units, report)).toEqual(new Map([["3.2", "Predicts a variance per joint."]]));
    expect(unitsToSummarize(units, report).map((u) => u.key)).not.toContain("3.2");
    expect(report.summaries[unit("3.2").hash]).toEqual({ title: "Uncertainty Estimation", summary: "Predicts a variance per joint.", updatedAt: 5 });
  });

  it("keeps the summaries of the current units and only the newest of the others", () => {
    const old = Array.from({ length: 205 }, (_, i) => ({ hash: `old${i}`, title: "Gone", summary: `old ${i}` }));
    let report = emptyReport();
    old.forEach((entry, i) => (report = withSummaries(report, [entry], units, i)));
    report = withSummaries(report, [{ hash: unit("1").hash, title: "Introduction", summary: "Why." }], units, 1000);
    expect(Object.keys(report.summaries)).toHaveLength(201);
    expect(report.summaries.old0).toBeUndefined();
    expect(report.summaries.old204).toBeDefined();
    expect(report.summaries[unit("1").hash].summary).toBe("Why.");
  });

  it("reads a saved report and starts empty from anything else", () => {
    const saved = { version: REPORT_VERSION, summaries: { a1: { title: "Method", summary: "Routes joints.", updatedAt: 3 }, bad: { summary: "  " } } };
    expect(readReport(saved)).toEqual({ version: REPORT_VERSION, summaries: { a1: { title: "Method", summary: "Routes joints.", updatedAt: 3 } } });
    expect(readReport({ version: 99, summaries: saved.summaries })).toEqual(emptyReport());
    expect(readReport(null)).toEqual(emptyReport());
    expect(readReport("x")).toEqual(emptyReport());
  });
});
