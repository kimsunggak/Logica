import { describe, expect, it } from "vitest";
import { parseIntent } from "./intent";

describe("parseIntent", () => {
  it("reads the type and the restated question", () => {
    expect(parseIntent('{"type":"method","intent":"How does the routing module pick tokens?"}', "q")).toEqual({
      type: "method",
      text: "How does the routing module pick tokens?",
    });
  });

  it("accepts JSON wrapped in prose or a code fence", () => {
    expect(parseIntent('Here:\n```json\n{"type":"result","intent":"What does Table 2 show?"}\n```', "q").type).toBe("result");
  });

  it("maps an unknown type to other", () => {
    expect(parseIntent('{"type":"summary","intent":"Summarize the paper."}', "q").type).toBe("other");
  });

  it("falls back to the reply text, or the question, when the reply is not JSON", () => {
    expect(parseIntent("The user wants a summary.", "q")).toEqual({ type: "other", text: "The user wants a summary." });
    expect(parseIntent("", "What is this?")).toEqual({ type: "other", text: "What is this?" });
  });
});
