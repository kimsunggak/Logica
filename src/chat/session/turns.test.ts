import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { capText, judgeTurns, moduleTurns, turnMessages, turnsOf, type TurnMessage, type TurnRecord } from "./turns";

const q = (content: string): TurnMessage => ({ role: "user", content, status: "done" });
const a = (content: string, extra: Partial<TurnMessage> = {}): TurnMessage => ({ role: "assistant", content, status: "done", ...extra });
const turns = (n: number): TurnRecord[] => Array.from({ length: n }, (_, i) => ({ index: i + 1, question: `q${i + 1}`, answer: `a${i + 1}`, status: "done" }));

describe("turnsOf", () => {
  it("keeps every turn, and marks the ones that did not finish", () => {
    const list = turnsOf([
      q("first"),
      a("answer"),
      q("second"),
      a("partial", { status: "cancelled" }),
      q("third"),
      a("Provider returned HTTP 503", { status: "error" }),
      q("fourth"),
      a("어느 표인가요?", { route: "clarify" }),
      q("fifth"),
      a(`long answer\n\n${t("chat.truncated")}`, { truncated: true }),
      q("sixth"),
      a("", { status: "streaming" }),
    ]);
    expect(list.map((turn) => [turn.index, turn.status, turn.answer])).toEqual([
      [1, "done", "answer"],
      [2, "cancelled", "partial\n[answer stopped by the user]"],
      // The error text is for the user, not for the model.
      [3, "error", "[answer failed]"],
      [4, "clarify", "어느 표인가요?"],
      [5, "truncated", "long answer\n[answer cut off at the length limit]"],
    ]);
  });

  it("marks a turn stopped before any text", () => {
    expect(turnsOf([q("x"), a("", { status: "cancelled" })])[0].answer).toBe("[answer stopped by the user]");
  });
});

describe("capText", () => {
  it("keeps short text as it is", () => {
    expect(capText("abc", 10)).toBe("abc");
  });

  it("keeps the start and the end of long text", () => {
    const text = `${"A".repeat(5000)}${"B".repeat(5000)}이 부분을 고쳐줘`;
    const out = capText(text, 4000);
    expect(out.startsWith("A".repeat(2800))).toBe(true);
    expect(out.endsWith("이 부분을 고쳐줘")).toBe(true);
    expect(out).toContain(`[... ${text.length - 4000} of ${text.length} characters omitted ...]`);
    // The same message is cut the same way every time.
    expect(capText(text, 4000)).toBe(out);
  });
});

describe("windows", () => {
  it("gives the judge the last four turns", () => {
    expect(judgeTurns(turns(6)).map((turn) => turn.index)).toEqual([3, 4, 5, 6]);
    expect(judgeTurns(turns(2)).map((turn) => turn.index)).toEqual([1, 2]);
  });

  it("gives the modules the turns after the summary, at least two and at most eight", () => {
    expect(moduleTurns(turns(5), 2).map((turn) => turn.index)).toEqual([3, 4, 5]);
    expect(moduleTurns(turns(4), 4).map((turn) => turn.index)).toEqual([3, 4]);
    expect(moduleTurns(turns(3), 0).map((turn) => turn.index)).toEqual([1, 2, 3]);
    expect(moduleTurns(turns(12), 0).map((turn) => turn.index)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("turns them into messages and reports what was cut", () => {
    const list: TurnRecord[] = [{ index: 7, question: "x".repeat(50), answer: "short", status: "done" }];
    const { messages, clipped } = turnMessages(list, 20);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe("short");
    expect(clipped).toEqual([{ turn: 7, role: "user", original_chars: 50 }]);
  });
});
