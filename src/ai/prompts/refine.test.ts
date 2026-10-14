import { describe, expect, it } from "vitest";
import { buildPrompt } from "./index";

describe("section selection prompt", () => {
  it("sends the paper map and the cursor section, and asks for JSON", () => {
    const prompt = buildPrompt({
      id: "1",
      task: "select",
      instruction: "What does this section claim?",
      context: { currentFile: "main.tex", currentSection: "[s2] 2 Method" },
      paperMap: "sections:\n[s1] 1 Introduction\n[s2] 2 Method",
      model: "m",
    });
    const user = prompt.messages.at(-1)!.content;
    expect(user).toContain("<paper_map>\nsections:\n[s1] 1 Introduction\n[s2] 2 Method\n</paper_map>");
    expect(user).toContain("cursor_section: [s2] 2 Method");
    expect(user).toContain("<user_message>\nWhat does this section claim?\n</user_message>");
    expect(prompt.system).toContain('{"intent":"ask","sections":["s2","s5"],"focus":"..."}');
  });
});

describe("refined answer prompt", () => {
  it("combines the selected sections, the restated question and the user's words", () => {
    const prompt = buildPrompt({
      id: "1",
      task: "answer",
      instruction: "실험은 어떤 데이터로 했어?",
      context: { paperTitle: "Adaptive Routing", outline: "1 Introduction\n2 Experiments" },
      sources: [{ key: "s2", label: '2 "Experiments"', text: "We test on three datasets." }],
      focus: "Which datasets are used in the experiments?",
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      model: "m",
    });
    const user = prompt.messages.at(-1)!.content;
    expect(user).toContain('<section key="s2" title="2 \'Experiments\'">\nWe test on three datasets.\n</section>');
    expect(user).toContain("<question_focus>\nWhich datasets are used in the experiments?\n</question_focus>");
    expect(user.indexOf("<selected_sections>")).toBeLessThan(user.indexOf("<user_message>"));
    expect(user).not.toContain("<project_files>");
    expect(prompt.messages).toHaveLength(3);
    expect(prompt.system).toContain("Do not write edit blocks");
  });
});
