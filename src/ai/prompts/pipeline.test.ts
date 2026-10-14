import { describe, expect, it } from "vitest";
import { buildPrompt } from "./index";

describe("Intent Module prompt", () => {
  it("sends the question with the editor location and asks for JSON only", () => {
    const prompt = buildPrompt({
      id: "1",
      task: "intent",
      instruction: "이 방법이 왜 가림에 강해?",
      context: {
        paperTitle: "Adaptive Routing",
        outline: "1 Introduction\n2 Method",
        currentFile: "main.tex",
        currentSection: "2 Method",
        currentParagraph: "We route tokens by uncertainty.",
      },
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      model: "m",
    });
    expect(prompt.messages).toHaveLength(1);
    const user = prompt.messages[0].content;
    expect(user).toContain("<paper_outline>\n1 Introduction\n2 Method\n</paper_outline>");
    expect(user).toContain("<current_section>\n2 Method\n</current_section>");
    expect(user).toContain("<cursor_paragraph>\nWe route tokens by uncertainty.\n</cursor_paragraph>");
    expect(user).toContain("<recent_conversation>\nuser: Hi\nassistant: Hello\n</recent_conversation>");
    expect(user).toContain("<user_message>\n이 방법이 왜 가림에 강해?\n</user_message>");
    expect(prompt.system).toContain('{"type":"method","intent":"..."}');
  });
});

describe("Answer Agent prompt", () => {
  it("sends the whole paper, the intent and the original question", () => {
    const prompt = buildPrompt({
      id: "1",
      task: "answer",
      instruction: "실험은 어떤 데이터로 했어?",
      context: { currentFile: "sections/exp.tex" },
      projectFiles: [
        { path: "main.tex", text: "\\input{sections/exp}" },
        { path: "sections/exp.tex", text: "We test on three datasets." },
      ],
      omittedFiles: ["appendix.tex"],
      intent: { type: "result", text: "Which datasets are used in the experiments?" },
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      model: "m",
    });
    const user = prompt.messages.at(-1)!.content;
    expect(user).toContain('<paper>\n<file path="main.tex">\n\\input{sections/exp}\n</file>\n<file path="sections/exp.tex">');
    expect(user).toContain("<omitted_files>\nappendix.tex\n</omitted_files>\n</paper>");
    expect(user).toContain('<intent type="result">\nWhich datasets are used in the experiments?\n</intent>');
    expect(user.indexOf("<intent")).toBeLessThan(user.indexOf("<user_message>"));
    expect(prompt.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(prompt.system).toContain("```edit <file path>");
  });
});
