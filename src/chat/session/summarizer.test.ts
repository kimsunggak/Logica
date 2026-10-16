import { describe, expect, it } from "vitest";
import type { ChatRequest, GatewayResult } from "../../ai/gateway";
import { CHAT_MODELS } from "../../ai/models/modelConfig";
import { buildPrompt } from "../../ai/prompts";
import type { AIResponse, ChatTask } from "../../ai/types";
import { foldTurns, turnsToFold } from "./summarizer";
import { renderSummary } from "./summary";
import type { TurnRecord } from "./turns";

const turns = (n: number, status: (i: number) => TurnRecord["status"] = () => "done"): TurnRecord[] =>
  Array.from({ length: n }, (_, i) => ({ index: i + 1, question: `q${i + 1}`, answer: `a${i + 1}`, status: status(i + 1) }));

function gateway(response: Partial<AIResponse>) {
  const log: { task: ChatTask; request: ChatRequest }[] = [];
  const call = async (task: ChatTask, request: ChatRequest): Promise<GatewayResult> => {
    log.push({ task, request });
    return { response: { id: "r", provider: "openai", model: "gpt-6.1-sol", text: "", finishReason: "stop", ...response }, choice: CHAT_MODELS[task].primary };
  };
  return { call: call as never, log };
}
const control = () => ({ stopped: false, activeRequest: null as string | null });

describe("turnsToFold", () => {
  it("folds all but the last two turns once four are open", () => {
    expect(turnsToFold(turns(3), null)).toEqual([]);
    expect(turnsToFold(turns(4), null).map((t) => t.index)).toEqual([1, 2]);
    const covered = { coveredTurns: 2, goal: "", items: [], next: { preference: 1, topic: 1, reference: 1, unresolved: 1 } };
    expect(turnsToFold(turns(5), covered)).toEqual([]);
    expect(turnsToFold(turns(6), covered).map((t) => t.index)).toEqual([3, 4]);
  });

  it("catches up a long session six turns at a time", () => {
    expect(turnsToFold(turns(20), null).map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("foldTurns", () => {
  it("sends the summary so far and the turns to fold, with the open requests already added", async () => {
    const { call, log } = gateway({
      toolCalls: [
        {
          id: "c1",
          name: "update_summary",
          arguments: {
            ops: [
              { op: "set_goal", kind: "", id: "", text: "표 해석", turn: 0 },
              { op: "add", kind: "topic", id: "", text: "표 2", turn: 1 },
              { op: "close", kind: "", id: "U1", text: "턴 2에서 다시 물어 답함", turn: 0 },
            ],
          },
        },
      ],
    });
    const fold = turns(2, (i) => (i === 1 ? "cancelled" : "done"));
    const result = await foldTurns(null, fold, { traceId: "s1", control: control(), outline: "1 Intro\n2 Method", call });
    expect(log.map((c) => c.task)).toEqual(["summary"]);
    const request = log[0].request;
    expect(request.tools?.map((t) => t.name)).toEqual(["update_summary"]);
    expect(request.sessionSummary).toContain('U1 (turn 1): The user stopped the answer to "q1".');
    expect(request.foldTurns?.map((t) => t.index)).toEqual([1, 2]);
    const prompt = buildPrompt({ ...request, task: "summary", model: "m" }).messages[0].content;
    expect(prompt).toContain("<paper_outline>\n1 Intro\n2 Method\n</paper_outline>");
    expect(prompt).toContain('<turn number="2">\nuser: q2\nassistant: a2\n</turn>');
    expect(result.summary.coveredTurns).toBe(2);
    expect(result.ignored).toEqual([]);
    expect(renderSummary(result.summary)).toContain("Goal: 표 해석");
    expect(result.summary.items.find((item) => item.id === "U1")?.status).toBe("closed");
  });

  it("fails without a tool call, so the turns are folded again later", async () => {
    const { call } = gateway({ text: "Here is the summary." });
    await expect(foldTurns(null, turns(2), { traceId: "s2", control: control(), call })).rejects.toThrow("did not call update_summary");
  });
});
