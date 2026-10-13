import { describe, expect, it } from "vitest";
import { buildChatPrompt } from "./chat";

describe("buildChatPrompt", () => {
  it("sends the paper files and asks for edit blocks", () => {
    const prompt = buildChatPrompt({
      id: "1",
      task: "chat",
      instruction: "Unify the terminology.",
      context: { currentFile: "sections/a.tex" },
      projectFiles: [{ path: "sections/a.tex", text: "Some text." }],
      omittedFiles: ["sections/huge.tex"],
      model: "m",
    });
    const user = prompt.messages.at(-1)!.content;
    expect(user).toContain('<file path="sections/a.tex">\nSome text.\n</file>');
    expect(user).toContain("<omitted_files>\nsections/huge.tex\n</omitted_files>");
    expect(prompt.system).toContain("```edit <file path>");
  });
});
