import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { samplePaper } from "../../test/samplePaper";
import { emptyReport, hasSummaries, readReportYaml, reportYaml, summariesFor, unitsToSummarize, withSummaries } from "./report";
import { FRONT, paperUnits } from "./sections";

const files = samplePaper();
const { units } = paperUnits(buildPaperDocument({ files }), files);
const unit = (key: string) => units.find((u) => u.key === key)!;
const summarized = (keys: string[]) =>
  withSummaries(emptyReport(), keys.map((k) => ({ hash: unit(k).hash, title: unit(k).title, summary: `${unit(k).title} 요약 1줄.\n2줄.` })), units);

describe("paper summary", () => {
  it("finds summaries by the unit's hash, the abstract included", () => {
    expect(hasSummaries(units, emptyReport())).toBe(false);
    expect(unitsToSummarize(units, emptyReport())).toHaveLength(units.length);
    const report = summarized([FRONT, "3.2"]);
    expect(hasSummaries(units, report)).toBe(true);
    expect([...summariesFor(units, report).keys()]).toEqual(["metadata", FRONT, "3.2"]);
    expect(unitsToSummarize(units, report).map((u) => u.key)).not.toContain("3.2");
  });

  it("keeps only the summaries of the sections the paper has now", () => {
    const report = withSummaries(summarized(["1"]), [{ hash: "gone", title: "Old", summary: "Removed section." }], units);
    expect(Object.keys(report.summaries)).toEqual([unit("metadata").hash, unit("1").hash]);
  });

  it("writes a YAML document in reading order, with subsections under their section", () => {
    const text = reportYaml(summarized([FRONT, "1", "1.1"]), units, "STRoute", new Date("2026-10-21T00:00:00Z"));
    expect(text.startsWith("# LOGICA 논문 요약")).toBe(true);
    const doc = parse(text);
    expect(doc).toMatchObject({ version: 1, title: "STRoute", updated: "2026-10-21T00:00:00.000Z" });
    expect(doc.sections.map((s: { key: string }) => s.key)).toEqual(["metadata", FRONT, "1", "2", "3", "4", "5"]);
    const intro = doc.sections.find((s: { key: string }) => s.key === "1");
    expect(intro).toMatchObject({ key: "1", title: "Introduction", hash: unit("1").hash, summary: "Introduction 요약 1줄.\n2줄." });
    expect(intro.subsections.map((s: { key: string }) => s.key)).toEqual(["1.1", "1.2", "1.3"]);
    // A section without a summary yet is listed with none.
    expect(intro.subsections[1]).toMatchObject({ key: "1.2", summary: null });
    // A summary of several lines is a literal block.
    expect(text).toContain("    summary: |-\n      Introduction 요약 1줄.\n      2줄.");
    // Section numbers stay strings.
    expect(text).toContain('key: "1"');
  });

  it("reads its own document back, and starts empty from anything else", () => {
    const report = summarized([FRONT, "1", "3.2"]);
    expect(readReportYaml(reportYaml(report, units))).toEqual(report);
    expect(readReportYaml("version: 2\nsections: []")).toEqual(emptyReport());
    expect(readReportYaml("sections: [unclosed")).toEqual(emptyReport());
    expect(readReportYaml(null)).toEqual(emptyReport());
  });
});
