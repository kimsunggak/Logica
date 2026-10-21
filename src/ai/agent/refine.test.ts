import { describe, expect, it } from "vitest";
import { parseRefine } from "./refine";

describe("parseRefine", () => {
  it("reads a refined question", () => {
    expect(parseRefine('{"refined_question":"What problem does the method in Section 3 solve?"}', "q")).toEqual({
      kind: "refined",
      text: "What problem does the method in Section 3 solve?",
    });
  });

  it("reads the sections the answer should read word for word", () => {
    expect(parseRefine('{"refined_question":"Explain Eq. 1","sections":["3.2", 4]}', "q")).toEqual({ kind: "refined", text: "Explain Eq. 1", sections: ["3.2"] });
    expect(parseRefine('{"refined_question":"Summarize","sections":[]}', "q")).toEqual({ kind: "refined", text: "Summarize", sections: [] });
  });

  it("reads a question to ask the user back", () => {
    expect(parseRefine('{"clarify":"Which table do you mean?"}', "q")).toEqual({ kind: "clarify", text: "Which table do you mean?" });
  });

  it("finds the JSON inside prose or a code fence", () => {
    expect(parseRefine('Sure:\n```json\n{"refined_question":"Summarize Table 2."}\n```', "q")).toEqual({ kind: "refined", text: "Summarize Table 2." });
  });

  it("prefers the refined question when both are given", () => {
    expect(parseRefine('{"refined_question":"A","clarify":"B"}', "q").kind).toBe("refined");
  });

  it("uses the reply text, or the user's message, when there is no JSON", () => {
    expect(parseRefine("What does Table 2 show?", "q")).toEqual({ kind: "refined", text: "What does Table 2 show?" });
    expect(parseRefine("", "What is this?")).toEqual({ kind: "refined", text: "What is this?" });
    expect(parseRefine('{"refined_question": ', "What is this?")).toEqual({ kind: "refined", text: "What is this?" });
    expect(parseRefine('{"refined_question":"  "}', "What is this?")).toEqual({ kind: "refined", text: "What is this?" });
  });
});
