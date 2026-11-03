import { describe, expect, it } from "vitest";
import { SSEParser } from "./sse";

describe("SSEParser", () => {
  it("parses events split across arbitrary chunks", () => {
    const parser = new SSEParser();
    const input = 'event: a\ndata: {"x":1}\n\n: comment\ndata: line1\ndata: line2\r\n\r\nevent: b\ndata: end\n\n';
    const events = [];
    for (let i = 0; i < input.length; i += 3) events.push(...parser.push(input.slice(i, i + 3)));
    events.push(...parser.end());
    expect(events).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: undefined, data: "line1\nline2" },
      { event: "b", data: "end" },
    ]);
  });
  it("flushes a trailing event without blank line", () => {
    const parser = new SSEParser();
    expect(parser.push("data: tail")).toEqual([]);
    expect(parser.end()).toEqual([{ event: undefined, data: "tail" }]);
  });
});
