import { describe, expect, it } from "vitest";
import { AIError } from "../../ai/errors";
import type { ChatRequest, GatewayResult } from "../../ai/gateway";
import { CHAT_MODELS } from "../../ai/models/modelConfig";
import { buildPrompt } from "../../ai/prompts";
import type { ChatTask } from "../../ai/types";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { samplePaper } from "../../test/samplePaper";
import { unitsToSummarize, emptyReport } from "./report";
import { batchesOf, SECTION_BATCH_CHARS, summarizeSections } from "./sectionSummarizer";
import { paperUnits, type SectionUnit } from "./sections";

const files = samplePaper();
const { units } = paperUnits(buildPaperDocument({ files }), files);
const sections = unitsToSummarize(units, emptyReport());
const control = () => ({ stopped: false, activeRequest: null as string | null });

/** A fake gateway: summarizes every section it is sent, except the ones in `skip`. */
function gateway(options: { skip?: string[]; fail?: (request: ChatRequest) => boolean } = {}) {
  const log: { task: ChatTask; request: ChatRequest }[] = [];
  const call = async (task: ChatTask, request: ChatRequest): Promise<GatewayResult> => {
    log.push({ task, request });
    if (options.fail?.(request)) throw new AIError("unavailable", "down");
    const summaries = (request.sectionsToSummarize ?? []).filter((s) => !options.skip?.includes(s.key)).map((s) => ({ key: s.key, summary: `About ${s.title}.` }));
    return {
      response: { id: "r", provider: "openai", model: "gpt-6.1-sol", text: "", finishReason: "stop", toolCalls: [{ id: "c1", name: "write_section_summaries", arguments: { summaries } }] },
      choice: CHAT_MODELS[task].primary,
    };
  };
  return { call: call as never, log };
}

describe("batchesOf", () => {
  it("fills each batch up to the batch size", () => {
    const unit = (key: string, chars: number) => ({ key, chars }) as SectionUnit;
    // A section counts at most 20,000 characters, as only that much of it is sent.
    const batches = batchesOf([unit("1", 15_000), unit("2", 15_000), unit("3", 15_000), unit("4", 60_000), unit("5", 8_000)]);
    expect(batches.map((b) => b.map((u) => u.key))).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(SECTION_BATCH_CHARS).toBe(40_000);
  });
});

describe("summarizeSections", () => {
  it("summarizes the sample paper in one call, and keeps headings with few words as they are", async () => {
    const { call, log } = gateway();
    const result = await summarizeSections(sections, { traceId: "p1", control: control(), title: "STRoute", outline: "1 Introduction", call });
    expect(log.map((c) => c.task)).toEqual(["sections"]);
    const sent = log[0].request.sectionsToSummarize!.map((s) => s.key);
    // "3 Method" holds only its heading and label: no model call for it.
    expect(sent).not.toContain("3");
    expect(sent).toContain("3.2");
    expect(result.missing).toEqual([]);
    expect(result.summarized.map((s) => s.key).sort()).toEqual(sections.map((u) => u.key).sort());
    expect(result.summarized.find((s) => s.key === "3")!.summary).toBe("Only its heading; its text is in its subsections.");
    expect(result.summarized.find((s) => s.key === "3.2")).toMatchObject({ summary: "About Uncertainty Estimation.", hash: units.find((u) => u.key === "3.2")!.hash });

    const prompt = buildPrompt({ ...log[0].request, task: "sections", model: "m" });
    expect(prompt.system).toContain("write_section_summaries");
    expect(prompt.messages[0].content).toContain("<paper_title>\nSTRoute\n</paper_title>");
    expect(prompt.messages[0].content).toContain('<section key="3.2" title="Uncertainty Estimation">\n\\subsection{Uncertainty Estimation}');
  });

  it("reports the sections the model left out, to summarize them after the next turn", async () => {
    const { call } = gateway({ skip: ["4.3"] });
    const result = await summarizeSections(sections, { traceId: "p2", control: control(), call });
    expect(result.missing).toEqual(["4.3"]);
    expect(result.summarized.map((s) => s.key)).not.toContain("4.3");
  });

  it("keeps what other batches wrote when one fails, and fails when nothing was written", async () => {
    // Two sections per batch.
    const long = sections.filter((u) => u.words >= 12).map((u) => ({ ...u, chars: 15_000 }));
    const { call, log } = gateway({ fail: (r) => r.id === "p3-sections-1" });
    const result = await summarizeSections(long, { traceId: "p3", control: control(), call });
    expect(log).toHaveLength(Math.ceil(long.length / 2));
    expect(result.missing).toEqual(long.slice(0, 2).map((u) => u.key));
    expect(result.summarized).toHaveLength(long.length - 2);

    const failing = gateway({ fail: () => true });
    await expect(summarizeSections(long, { traceId: "p4", control: control(), call: failing.call })).rejects.toMatchObject({ kind: "unavailable" });
  });
});
