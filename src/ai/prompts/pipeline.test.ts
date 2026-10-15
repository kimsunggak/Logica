import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../providers/openai/openaiProvider";
import type { AIRequest } from "../types";
import { buildPrompt } from "./index";

const files = [
  { path: "main.tex", text: "\\input{sections/exp}" },
  { path: "sections/exp.tex", text: "We test on three datasets." },
];
const history = [
  { role: "user" as const, content: "Hi" },
  { role: "assistant" as const, content: "Hello" },
];
const turn: Omit<AIRequest, "task"> = {
  id: "1",
  instruction: "실험은 어떤 데이터로 했어?",
  context: { currentFile: "sections/exp.tex", currentSection: "4 Experiments", currentParagraph: "We test on three datasets." },
  projectFiles: files,
  omittedFiles: ["appendix.tex"],
  history,
  model: "m",
};

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

describe("judge prompt", () => {
  it("sends the message, location and recent conversation, but not the paper", () => {
    const prompt = buildPrompt({ ...turn, task: "judge" });
    expect(prompt.messages).toHaveLength(1);
    const user = prompt.messages[0].content;
    expect(user).toContain("<current_section>\n4 Experiments\n</current_section>");
    expect(user).toContain("<cursor_paragraph>\nWe test on three datasets.\n</cursor_paragraph>");
    expect(user).toContain("<recent_conversation>\nuser: Hi\nassistant: Hello\n</recent_conversation>");
    expect(user.endsWith("<user_message>\n실험은 어떤 데이터로 했어?\n</user_message>")).toBe(true);
    expect(user).not.toContain("<paper>");
    expect(prompt.system).toContain("refine_question");
    expect(prompt.system).toContain("answer_question");
  });

  it("keeps only the last two exchanges, clipped", () => {
    const long = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn ${i} ${"x".repeat(700)}` }));
    const user = buildPrompt({ ...turn, task: "judge", history: long }).messages[0].content;
    expect(user).not.toContain("turn 3");
    expect(user).toContain("turn 4");
    expect(user).toContain("turn 7");
    expect(user).toContain("…");
  });
});

describe("refine and answer prompts", () => {
  it("put the paper first and the module's task last", () => {
    const refine = buildPrompt({ ...turn, task: "refine" });
    const first = refine.messages[0].content;
    expect(first.startsWith('<paper>\n<file path="main.tex">\n\\input{sections/exp}\n</file>\n<file path="sections/exp.tex">')).toBe(true);
    expect(first).toContain("<omitted_files>\nappendix.tex\n</omitted_files>\n</paper>");
    const last = refine.messages.at(-1)!.content;
    expect(last.indexOf("<editor_location>")).toBeLessThan(last.indexOf("<user_message>"));
    expect(last.indexOf("<user_message>")).toBeLessThan(last.indexOf("<task>"));
    expect(last).toContain('{"refined_question":"..."} or {"clarify":"..."}');
    expect(refine.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("give the answer the refined question next to the user's own message", () => {
    const answer = buildPrompt({ ...turn, task: "answer", refinedQuestion: "Which datasets are used in Section 4?" });
    const last = answer.messages.at(-1)!.content;
    expect(last).toContain("<user_message>\n실험은 어떤 데이터로 했어?\n</user_message>");
    expect(last).toContain("<refined_question>\nWhich datasets are used in Section 4?\n</refined_question>");
    expect(last.indexOf("<refined_question>")).toBeLessThan(last.indexOf("<task>"));
    expect(last).toContain("```edit <file path>");
    expect(buildPrompt({ ...turn, task: "answer" }).messages.at(-1)!.content).not.toContain("<refined_question>\n");
  });

  it("share everything before the last message, so the second call can hit the prompt cache", () => {
    const provider = new OpenAIProvider(() => "chatgpt");
    const refine = provider.buildBody({ ...turn, task: "refine" });
    const answer = provider.buildBody({ ...turn, task: "answer", refinedQuestion: "Which datasets?" });
    expect(answer.instructions).toBe(refine.instructions);
    const ri = refine.input as { role: string; content: string }[];
    const ai = answer.input as { role: string; content: string }[];
    expect(ai.slice(0, -1)).toEqual(ri.slice(0, -1));
    expect(ai.at(-1)).not.toEqual(ri.at(-1));
  });

  it("keep the paper in the shared prefix when there is no conversation yet", () => {
    const provider = new OpenAIProvider(() => "chatgpt");
    const serialize = (body: Record<string, unknown>) => JSON.stringify([body.instructions, body.input]);
    const refine = serialize(provider.buildBody({ ...turn, task: "refine", history: [] }));
    const answer = serialize(provider.buildBody({ ...turn, task: "answer", history: [] }));
    const shared = commonPrefix(refine, answer);
    expect(shared).toContain("We test on three datasets.");
    expect(shared).toContain("</paper>");
  });
});
