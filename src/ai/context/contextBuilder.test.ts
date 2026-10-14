import { describe, expect, it } from "vitest";
import { buildPaperDocument } from "../../latex/parser/documentModel";
import { buildPrompt } from "../prompts";
import { buildChatContext, buildEditContext } from "./contextBuilder";
import { paragraphContext } from "./paragraphs";

const text = "First paragraph.\n\nSecond paragraph line one.\nline two.\n\n\nThird paragraph.";

describe("paragraphContext", () => {
  it("returns neighbours of the selection", () => {
    const from = text.indexOf("Second");
    const ctx = paragraphContext(text, from, from + 6);
    expect(ctx.previous).toBe("First paragraph.");
    expect(ctx.current).toBe("Second paragraph line one.\nline two.");
    expect(ctx.next).toBe("Third paragraph.");
  });
  it("keeps headings and environments out of paragraphs", () => {
    const src = "\\subsection{Motivation}\nProse line one.\nProse line two.\n\\begin{equation}\nx = y\n\\end{equation}\nAfter.";
    const from = src.indexOf("Prose line two");
    const ctx = paragraphContext(src, from, from);
    expect(ctx.current).toBe("Prose line one.\nProse line two.");
    expect(ctx.next).toBe("x = y");
    expect(ctx.previous).toBeUndefined();
  });
  it("handles a cursor in a blank gap", () => {
    const pos = text.indexOf("\n\n\n") + 1;
    const ctx = paragraphContext(text, pos, pos);
    expect(ctx.current).toBeUndefined();
    expect(ctx.previous).toContain("Second");
    expect(ctx.next).toBe("Third paragraph.");
  });
});

describe("context builder + prompts", () => {
  const main = "\\documentclass{article}\\title{My Paper}\n\\begin{document}\n\\begin{abstract}An abstract.\\end{abstract}\n\\section{Method}\n\\subsection{Routing}\nPrev para.\n\nSelected sentence here.\n\nNext para.\n\\end{document}\n";
  const files = new Map([["main.tex", main]]);
  const doc = buildPaperDocument({ files });
  const from = main.indexOf("Selected");
  const snap = { projectName: "paper", filePath: "main.tex", text: main, selectionFrom: from, selectionTo: from + 23 };

  it("builds edit context from the paper model", () => {
    const ctx = buildEditContext(doc, snap);
    expect(ctx.paperTitle).toBe("My Paper");
    expect(ctx.abstract).toBe("An abstract.");
    expect(ctx.currentSection).toBe("1 Method › 1.1 Routing");
    expect(ctx.previousParagraph).toContain("Prev para.");
    expect(ctx.nextParagraph).toContain("Next para.");
    expect(ctx.outline).toContain("1.1 Routing");
  });

  it("produces the same semantic prompt for every provider", () => {
    const ctx = buildEditContext(doc, snap);
    const prompt = buildPrompt({
      id: "r1",
      task: "inline-edit",
      instruction: "Make this more concise",
      selectedText: "Selected sentence here.",
      context: ctx,
      model: "m",
    });
    expect(prompt.messages).toHaveLength(1);
    const user = prompt.messages[0].content;
    expect(user).toContain("<selected_text>\nSelected sentence here.\n</selected_text>");
    expect(user).toContain("<current_section>");
    expect(user.indexOf("<previous_paragraph>")).toBeLessThan(user.indexOf("<selected_text>"));
    expect(user.indexOf("<selected_text>")).toBeLessThan(user.indexOf("<next_paragraph>"));
    expect(prompt.system).toContain("\\label");
  });

  it("chat context includes file and section source", () => {
    const ctx = buildChatContext(doc, { ...snap, selectionTo: snap.selectionFrom }, files);
    expect(ctx.currentFile).toBe("main.tex");
    expect(ctx.currentParagraph).toBe("Selected sentence here.");
    expect(ctx.currentSectionText).toContain("Prev para.");
    const prompt = buildPrompt({
      id: "r2",
      task: "answer",
      instruction: "shorten",
      context: ctx,
      history: [
        { role: "assistant", content: "orphan assistant turn" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      model: "m",
    });
    expect(prompt.messages[0].role).toBe("user");
    expect(prompt.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
