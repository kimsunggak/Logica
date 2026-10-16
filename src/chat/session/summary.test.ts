import { describe, expect, it } from "vitest";
import { addUnresolved, applyOps, emptySummary, pruneSummary, readOps, readSummary, renderSummary, type SummaryOp } from "./summary";
import type { TurnRecord } from "./turns";

const turn = (index: number, status: TurnRecord["status"] = "done", answer = "ok"): TurnRecord => ({ index, question: `question ${index}`, answer, status });
const op = (o: Partial<SummaryOp> & { op: string }): SummaryOp => ({ kind: "", id: "", text: "", turn: 0, ...o });

describe("session summary", () => {
  it("adds an open request for every turn that was not fully answered", () => {
    const s = addUnresolved(emptySummary(), [turn(1), turn(2, "cancelled"), turn(3, "error"), turn(4, "truncated"), turn(5, "clarify", "어느 표인가요?")]);
    expect(s.items.map((item) => [item.id, item.turn, item.text])).toEqual([
      ["U1", 2, 'The user stopped the answer to "question 2".'],
      ["U2", 3, 'The answer to "question 3" failed.'],
      ["U3", 4, 'The answer to "question 4" was cut off at the length limit.'],
      ["U4", 5, 'LOGICA asked back "어느 표인가요?" about "question 5".'],
    ]);
  });

  it("applies the changes and marks the folded turns as covered", () => {
    const folded = [turn(1), turn(2)];
    const { summary, ignored } = applyOps(
      emptySummary(),
      [
        op({ op: "set_goal", text: "4장 결과 해석 보강" }),
        op({ op: "add", kind: "preference", text: "답은 짧게", turn: 1 }),
        op({ op: "add", kind: "topic", text: "표 2의 지표", turn: 2 }),
        op({ op: "add", kind: "reference", text: "리뷰어 2: 표 3에 신뢰구간이 없다", turn: 9 }),
      ],
      folded,
    );
    expect(ignored).toEqual([]);
    expect(summary.coveredTurns).toBe(2);
    expect(summary.goal).toBe("4장 결과 해석 보강");
    // A turn outside the folded ones becomes the last folded turn.
    expect(summary.items.map((item) => [item.id, item.turn, item.source])).toEqual([
      ["P1", 1, undefined],
      ["T1", 2, undefined],
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

  it("lets the model close an open request but never add one", () => {
    const open = addUnresolved(emptySummary(), [turn(1, "cancelled")]);
    const { summary, ignored } = applyOps(
      open,
      [
        op({ op: "close", id: "U1", text: "turn 2 answered it" }),
        op({ op: "add", kind: "unresolved", text: "made up" }),
        op({ op: "close", id: "P9" }),
        op({ op: "close", id: "U1" }),
        op({ op: "replace", id: "U1", text: "x" }),
        op({ op: "add", kind: "topic", text: "" }),
        op({ op: "rewrite", text: "everything" }),
      ],
      [turn(1), turn(2)],
    );
    expect(summary.items).toEqual([expect.objectContaining({ id: "U1", status: "closed", note: "turn 2 answered it" })]);
    expect(ignored.map((i) => i.why)).toEqual([
      "cannot add unresolved",
      "no item P9",
      "U1 is already closed",
      "U1 cannot be replaced",
      "no text",
      "unknown operation rewrite",
    ]);
    // A settled request is no longer shown.
    expect(renderSummary(summary)).not.toContain("U1");
  });

  it("does not add the same item twice", () => {
    const once = applyOps(emptySummary(), [op({ op: "add", kind: "preference", text: "답은 짧게" })], [turn(1)]).summary;
    const { ignored } = applyOps(once, [op({ op: "add", kind: "preference", text: " 답은 짧게 " })], [turn(2)]);
    expect(ignored.map((i) => i.why)).toEqual(["duplicate"]);
  });

  it("renders the same text for the same summary, in a fixed order", () => {
    const { summary } = applyOps(
      addUnresolved(emptySummary(), [turn(2, "error")]),
      [op({ op: "add", kind: "topic", text: "표 2", turn: 1 }), op({ op: "add", kind: "preference", text: "짧게", turn: 1 }), op({ op: "set_goal", text: "목표" })],
      [turn(1), turn(2)],
    );
    const text = renderSummary(summary);
    expect(text).toBe(
      [
        "Turns 1-2 of this conversation are folded into this summary; later turns follow word for word.",
        "Goal: 목표",
        "Preferences (follow the active ones):\n- P1: 짧게",
        'Requests not fully answered:\n- U1 (turn 2): The answer to "question 2" failed.',
        "Topics covered:\n- T1 (turn 1): 표 2",
      ].join("\n\n"),
    );
    expect(renderSummary(JSON.parse(JSON.stringify(summary)))).toBe(text);
    expect(renderSummary(null)).toBe("");
    expect(renderSummary(emptySummary())).toBe("");
  });

  it("drops the oldest topics first when it grows too long, but keeps preferences and open requests", () => {
    let s = addUnresolved(emptySummary(), [turn(1, "error")]);
    s = applyOps(s, [op({ op: "add", kind: "preference", text: "짧게" })], [turn(1)]).summary;
    for (let i = 2; i <= 40; i++) s = applyOps(s, [op({ op: "add", kind: "topic", text: `topic ${i} ${"x".repeat(80)}`, turn: i })], [turn(i)]).summary;
    const pruned = pruneSummary(s, 1500);
    expect(renderSummary(pruned).length).toBeLessThanOrEqual(1500);
    const ids = pruned.items.map((item) => item.id);
    expect(ids).toContain("P1");
    expect(ids).toContain("U1");
    expect(ids).not.toContain("T1");
    expect(ids).toContain("T39");
  });

  it("reads the model's operations and a saved summary loosely", () => {
    expect(readOps({ ops: [{ op: "add", kind: "topic", text: "t", turn: 3 }, null, "x"] })).toEqual([op({ op: "add", kind: "topic", text: "t", turn: 3 })]);
    expect(readOps({})).toEqual([]);
    expect(readSummary(undefined)).toBeNull();
    expect(readSummary({ coveredTurns: "2" })).toBeNull();
    expect(readSummary({ coveredTurns: 2, goal: "g", items: [], next: { topic: 3 } })?.next).toEqual({ preference: 1, topic: 3, reference: 1, unresolved: 1 });
  });
});
