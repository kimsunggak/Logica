import { describe, expect, it } from "vitest";
import type { ChatRequest, GatewayResult } from "../../ai/gateway";
import { CHAT_MODELS } from "../../ai/models/modelConfig";
import { buildPrompt } from "../../ai/prompts";
import type { AIResponse, ChatTask } from "../../ai/types";
import { foldTurns, moduleChars, turnsToFold } from "./summarizer";
import { emptySummary, renderSummary } from "./summary";
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
  it("folds all but the last four turns once ten are open", () => {
    expect(turnsToFold(turns(9), null)).toEqual([]);
    expect(turnsToFold(turns(10), null).map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6]);
    const covered = { ...emptySummary(), coveredTurns: 6 };
    expect(turnsToFold(turns(15), covered)).toEqual([]);
    expect(turnsToFold(turns(16), covered).map((t) => t.index)).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("folds sooner once the open turns pass 40,000 characters as the modules read them", () => {
    const long = (n: number, chars: number): TurnRecord[] =>
      Array.from({ length: n }, (_, i) => ({ index: i + 1, question: "q".repeat(chars), answer: "a".repeat(chars), status: "done" }));
    // Each message counts up to the 4,000 characters the modules read of it.
    expect(moduleChars(long(1, 9_000))).toBe(8_000);
    // So five turns never pass the limit, and a run folds at least two turns.
    expect(turnsToFold(long(5, 9_000), null)).toEqual([]);
    expect(turnsToFold(long(6, 9_000), null).map((t) => t.index)).toEqual([1, 2]);
    // 4,500 characters a turn: nine turns pass 40,000 before ten are open.
    expect(turnsToFold(long(8, 2_250), null)).toEqual([]);
    expect(turnsToFold(long(9, 2_250), null).map((t) => t.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("catches up a long session six turns at a time", () => {
    expect(turnsToFold(turns(20), null).map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("foldTurns", () => {
  it("sends the summary so far and the turns to fold, with the unfinished requests already added", async () => {
    const { call, log } = gateway({
      toolCalls: [
        {
          id: "c1",
          name: "update_summary",
          arguments: {
            ops: [
              { op: "set_topic", kind: "", id: "", text: "비디오 자세 추정", turn: 0 },
              { op: "set_goal", kind: "", id: "", text: "표 해석", turn: 0 },
              { op: "add", kind: "history", id: "", text: "표 2 → 지표 설명", turn: 1 },
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
    expect(renderSummary(result.summary)).toContain("Topic: 비디오 자세 추정\nGoal: 표 해석");
    expect(renderSummary(result.summary)).toContain("Session history:\n- turn 1: 표 2 → 지표 설명");
    expect(result.summary.items.find((item) => item.id === "U1")?.status).toBe("closed");
  });

  it("fails without a tool call, so the turns are folded again later", async () => {
    const { call } = gateway({ text: "Here is the summary." });
    await expect(foldTurns(null, turns(2), { traceId: "s2", control: control(), call })).rejects.toThrow("did not call update_summary");
  });
});
