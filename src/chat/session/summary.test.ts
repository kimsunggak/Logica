import { describe, expect, it } from "vitest";
import { applyOps, emptySummary, pruneSummary, readOps, readSummary, renderSummary, type SummaryOp } from "./summary";
import type { TurnRecord } from "./turns";

const turn = (index: number, status: TurnRecord["status"] = "done", answer = "ok"): TurnRecord => ({ index, question: `question ${index}`, answer, status });
const op = (o: Partial<SummaryOp> & { op: string }): SummaryOp => ({ kind: "", id: "", text: "", turn: 0, ...o });

describe("session summary", () => {
  it("applies the changes and marks the folded turns as covered", () => {
    const folded = [turn(1), turn(2)];
    const { summary, ignored } = applyOps(
      emptySummary(),
      [
        op({ op: "set_topic", text: "비디오 자세 추정의 시공간 라우팅" }),
        op({ op: "set_goal", text: "4장 결과 해석 보강" }),
        op({ op: "add", kind: "preference", text: "답은 짧게", turn: 1 }),
        op({ op: "add", kind: "history", text: "표 2의 지표 질문 → 정의와 해석 제시", turn: 2 }),
        op({ op: "add", kind: "reference", text: "리뷰어 2: 표 3에 신뢰구간이 없다", turn: 9 }),
      ],
      folded,
    );
    expect(ignored).toEqual([]);
    expect(summary.coveredTurns).toBe(2);
    expect(summary.topic).toBe("비디오 자세 추정의 시공간 라우팅");
    expect(summary.goal).toBe("4장 결과 해석 보강");
    // A turn outside the folded ones becomes the last folded turn.
    expect(summary.items.map((item) => [item.id, item.turn, item.source])).toEqual([
      ["P1", 1, undefined],
      ["H1", 2, undefined],
      ["R1", 2, "paste"],
    ]);
  });

  it("replaces a preference and keeps the old one, marked", () => {
    const first = applyOps(emptySummary(), [op({ op: "add", kind: "preference", text: "용어는 recall", turn: 1 })], [turn(1)]).summary;
    const { summary } = applyOps(first, [op({ op: "replace", id: "P1", text: "용어는 재현율", turn: 2 })], [turn(2)]);
    expect(summary.items.map((item) => [item.id, item.status, item.by])).toEqual([
      ["P1", "replaced", "P2"],
      ["P2", "active", undefined],
    ]);
    expect(renderSummary(summary)).toContain("- P1 (replaced by P2): 용어는 recall\n- P2: 용어는 재현율");
  });

  it("leaves out operations it does not allow", () => {
    const first = applyOps(emptySummary(), [op({ op: "add", kind: "history", text: "표 2 → 설명", turn: 1 })], [turn(1)]).summary;
    const { summary, ignored } = applyOps(
      first,
      [
        op({ op: "add", kind: "unresolved", text: "made up" }),
        op({ op: "close", id: "H1", text: "done" }),
        op({ op: "replace", id: "H1", text: "x" }),
        op({ op: "replace", id: "P9", text: "x" }),
        op({ op: "add", kind: "history", text: "" }),
        op({ op: "add", kind: "topic", text: "old kind" }),
        op({ op: "rewrite", text: "everything" }),
      ],
      [turn(2)],
    );
    expect(summary.items).toEqual(first.items);
    expect(ignored.map((i) => i.why)).toEqual([
      "cannot add unresolved",
      "unknown operation close",
      "H1 cannot be replaced",
      "no item P9",
      "no text",
      "cannot add topic",
      "unknown operation rewrite",
    ]);
  });

  it("does not add the same item twice", () => {
    const once = applyOps(emptySummary(), [op({ op: "add", kind: "preference", text: "답은 짧게" })], [turn(1)]).summary;
    const { ignored } = applyOps(once, [op({ op: "add", kind: "preference", text: " 답은 짧게 " })], [turn(2)]);
    expect(ignored.map((i) => i.why)).toEqual(["duplicate"]);
  });

  it("renders the same text for the same summary, in a fixed order", () => {
    const { summary } = applyOps(
      emptySummary(),
      [
        op({ op: "add", kind: "history", text: "표 3 → 해석 제시", turn: 2 }),
        op({ op: "add", kind: "history", text: "표 2 → 지표 설명", turn: 1 }),
        op({ op: "add", kind: "preference", text: "짧게", turn: 1 }),
        op({ op: "set_goal", text: "목표" }),
        op({ op: "set_topic", text: "주제" }),
      ],
      [turn(1), turn(2)],
    );
    const text = renderSummary(summary);
    // History lines go by their turn, oldest first, without ids.
    expect(text).toBe(
      [
        "Turns 1-2 of this conversation are folded into this summary; later turns follow word for word.",
        "Topic: 주제\nGoal: 목표",
        "Preferences (follow the active ones):\n- P1: 짧게",
        "Session history:\n- turn 1: 표 2 → 지표 설명\n- turn 2: 표 3 → 해석 제시",
      ].join("\n\n"),
    );
    expect(renderSummary(JSON.parse(JSON.stringify(summary)))).toBe(text);
    expect(renderSummary(null)).toBe("");
    expect(renderSummary(emptySummary())).toBe("");
  });

  it("drops the oldest history lines first when it grows too long, but keeps preferences", () => {
    let s = emptySummary();
    s = applyOps(s, [op({ op: "add", kind: "preference", text: "짧게" })], [turn(1)]).summary;
    for (let i = 2; i <= 40; i++) s = applyOps(s, [op({ op: "add", kind: "history", text: `turn ${i} ${"x".repeat(80)}`, turn: i })], [turn(i)]).summary;
    const pruned = pruneSummary(s, 1500);
    expect(renderSummary(pruned).length).toBeLessThanOrEqual(1500);
    const ids = pruned.items.map((item) => item.id);
    expect(ids).toContain("P1");
    const history = pruned.items.filter((item) => item.kind === "history").map((item) => item.turn);
    expect(history).not.toContain(2);
    expect(history).toContain(40);
  });

  it("reads the model's operations and a saved summary loosely", () => {
    expect(readOps({ ops: [{ op: "add", kind: "history", text: "t", turn: 3 }, null, "x"] })).toEqual([op({ op: "add", kind: "history", text: "t", turn: 3 })]);
    expect(readOps({})).toEqual([]);
    expect(readSummary(undefined)).toBeNull();
    expect(readSummary({ coveredTurns: "2" })).toBeNull();
    expect(readSummary({ coveredTurns: 2, goal: "g", items: [], next: { preference: 3 } })?.next).toEqual({ preference: 3, history: 1, reference: 1 });
  });

  it("reads a summary saved in the older format: topic lines become history, unfinished requests are dropped", () => {
    const saved = {
      coveredTurns: 2,
      goal: "4장 다듬기",
      items: [
        { id: "U1", kind: "unresolved", text: "The answer to \"표 1\" failed.", turn: 1, status: "active" },
        { id: "T1", kind: "topic", text: "표 2", turn: 1, status: "active" },
      ],
      next: { preference: 1, topic: 2, reference: 1, unresolved: 1 },
    };
    const summary = readSummary(saved)!;
    expect(summary).toMatchObject({ topic: "", goal: "4장 다듬기", next: { preference: 1, history: 1, reference: 1 } });
    expect(summary.next).not.toHaveProperty("topic");
    expect(renderSummary(summary)).toContain("Session history:\n- turn 1: 표 2");
    expect(summary.items.map((item) => item.id)).toEqual(["T1"]);
  });
});
