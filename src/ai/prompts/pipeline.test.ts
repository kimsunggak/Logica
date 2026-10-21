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
  it("sends the message and recent conversation, but not the paper or the editor's state", () => {
    const prompt = buildPrompt({ ...turn, task: "judge" });
    expect(prompt.messages).toHaveLength(1);
    const user = prompt.messages[0].content;
    // The open file, the cursor's section and paragraph often have nothing to do with the question.
    expect(user).not.toContain("<editor_location>");
    expect(user).not.toContain("<current_file>");
    expect(user).not.toContain("<current_section>");
    expect(user).not.toContain("<cursor_paragraph>");
    expect(user).toContain("<recent_conversation>\nuser: Hi\nassistant: Hello\n</recent_conversation>");
    expect(user.endsWith("<user_message>\n실험은 어떤 데이터로 했어?\n</user_message>")).toBe(true);
    expect(user).not.toContain("<paper>");
    expect(prompt.system).toContain("reply_directly");
    expect(prompt.system).toContain("refine_question");
    expect(prompt.system).toContain("answer_question");
    expect(prompt.system).toContain("never write the answer yourself");
  });

  it("puts what changes least first: paper map, summary, conversation, message", () => {
    const paperMap = [{ key: "1", title: "Introduction", depth: 0, words: 40, labels: [], summary: "Why." }];
    const user = buildPrompt({ ...turn, task: "judge", paperMap, sessionSummary: "Goal: tighten Section 4" }).messages[0].content;
    const order = ["<paper_map", "<session_summary>", "<recent_conversation>", "<user_message>"].map((tag) => user.indexOf(tag));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(user).toContain("<session_summary>\nGoal: tighten Section 4\n</session_summary>");
  });

  it.each(["judge", "reply"] as const)("%s sends the turns it is given in full, and explains the notes", (task) => {
    const long = [
      { role: "user" as const, content: `pasted ${"x".repeat(3000)} 이 문단 고쳐줘` },
      { role: "assistant" as const, content: "[answer stopped by the user]" },
    ];
    const prompt = buildPrompt({ ...turn, task, history: long });
    expect(prompt.messages[0].content).toContain(`${"x".repeat(3000)} 이 문단 고쳐줘`);
    expect(prompt.system).toContain("[answer stopped by the user]");
    expect(prompt.system).toContain("<session_summary>");
    expect(prompt.messages[0].content).not.toContain("<session_summary>");
  });
});

describe("reply prompt", () => {
  it("sends the message and recent exchanges, but not the paper or the open file", () => {
    const prompt = buildPrompt({ ...turn, task: "reply" });
    expect(prompt.messages).toHaveLength(1);
    const user = prompt.messages[0].content;
    expect(user).toContain("<recent_conversation>\nuser: Hi\nassistant: Hello\n</recent_conversation>");
    expect(user).toContain("<user_message>\n실험은 어떤 데이터로 했어?\n</user_message>");
    expect(user).not.toContain("<paper>");
    expect(user).not.toContain("<current_file>");
    expect(prompt.system).toContain("Reply Module");
  });

  it("reads the session summary before the conversation", () => {
    const user = buildPrompt({ ...turn, task: "reply", sessionSummary: "P1: 답은 짧게" }).messages[0].content;
    expect(user.indexOf("<session_summary>")).toBeLessThan(user.indexOf("<recent_conversation>"));
  });
});

describe("system prompt", () => {
  it("keeps the selection rule for inline edits only", () => {
    const rule = "Only edit the selected text.";
    expect(buildPrompt({ ...turn, task: "inline-edit", selectedText: "x" }).system).toContain(rule);
    expect(buildPrompt({ ...turn, task: "answer" }).system).not.toContain(rule);
    expect(buildPrompt({ ...turn, task: "refine" }).system).not.toContain(rule);
  });
});

describe("refine and answer prompts", () => {
  it("put the paper first and the module's task last", () => {
    const refine = buildPrompt({ ...turn, task: "refine" });
    const first = refine.messages[0].content;
    expect(first.startsWith('<paper>\n<file path="main.tex">\n\\input{sections/exp}\n</file>\n<file path="sections/exp.tex">')).toBe(true);
    expect(first).toContain("<omitted_files>\nappendix.tex\n</omitted_files>\n</paper>");
    const last = refine.messages.at(-1)!.content;
    expect(last).not.toContain("<editor_location>");
    expect(last).not.toContain("<current_section>");
    expect(last).not.toContain("<cursor_paragraph>");
    expect(last.startsWith("<user_message>")).toBe(true);
    expect(last.indexOf("<user_message>")).toBeLessThan(last.indexOf("<task>"));
    expect(last).toContain('{"refined_question":"..."} or {"clarify":"..."}');
    expect(refine.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("put the session summary right after the paper, before the conversation", () => {
    const answer = buildPrompt({ ...turn, task: "answer", sessionSummary: "U1 (turn 2): The answer failed." });
    const first = answer.messages[0].content;
    expect(first.indexOf("</paper>")).toBeLessThan(first.indexOf("<session_summary>"));
    expect(first.indexOf("<session_summary>")).toBeLessThan(first.indexOf("Hi"));
    expect(answer.messages.at(-1)!.content).toContain("requests that were not fully answered (U#)");
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
