import { describe, expect, it } from "vitest";
import { buildPrompt } from "./index";
import { CHAT_TOOLS, EDIT_TOOLS, sectionTools } from "../tools/chatTools";
import { OpenAIProvider } from "../providers/openai/openaiProvider";
import { AnthropicProvider } from "../providers/anthropic/anthropicProvider";
import type { AIRequest } from "../types";

const turn: Omit<AIRequest, "task"> = {
  id: "1", instruction: "그렇게 줄이면 기여가 빠지지 않아?", refinedQuestion: "Does shortening section 3 remove its contribution?",
  context: { currentFile: "unrelated.tex" }, model: "m",
  history: [{ role: "user", content: "Section 3 is too long." }, { role: "assistant", content: "We could shorten it." }],
  sessionSummary: "Goal: clarify the contribution",
  projectFiles: [{ path: "main.tex", text: "\\section{Method}\nExact paper source." }],
  paperMap: [{ key: "3", title: "Method", depth: 0, words: 30, labels: [], summary: "A summary of method." }],
};

describe("separate prompt responsibilities", () => {
  it("refines using conversational context and plain text, without paper source or routing", () => {
    const prompt = buildPrompt({ ...turn, task: "refine" });
    const content = prompt.messages[0].content;
    expect(content).toContain("Goal: clarify the contribution");
    expect(content).toContain("We could shorten it.");
    expect(content).toContain(turn.instruction);
    expect(content).not.toContain("Exact paper source.");
    expect(content).not.toContain("unrelated.tex");
    expect(prompt.system).toContain("plain text");
    expect(prompt.system).toContain("question versus command");
    expect(prompt.system).toContain("preserve that ambiguity");
    expect(prompt.system).not.toContain("refined_question");
  });

  it("Auto sees original and refined requests and history but has no section-selection tools", () => {
    const prompt = buildPrompt({ ...turn, task: "judge" });
    const content = prompt.messages[0].content;
    expect(content).toContain(turn.instruction);
    expect(content).toContain(turn.refinedQuestion);
    expect(content).toContain("A summary of method.");
    expect(content).not.toContain("Exact paper source.");
    expect(prompt.system).toContain("Auto Router");
    expect(prompt.system).toContain("hypothetical changes");
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual(["route_chat", "route_edit", "clarify_request"]);
    for (const tool of CHAT_TOOLS) expect(tool.parameters.properties).not.toHaveProperty("sections");
  });

  it.each(["chat", "edit"] as const)("selects sources for a fixed %s execution mode", (executionMode) => {
    const prompt = buildPrompt({ ...turn, task: "select", executionMode });
    expect(prompt.system).toContain("mode is already fixed");
    expect(prompt.messages[0].content).toContain("A summary of method.");
    expect(prompt.messages[0].content).not.toContain("Exact paper source.");
    const tools = sectionTools(executionMode);
    expect(tools[0].name).toBe(executionMode === "chat" ? "select_chat_sections" : "select_edit_sections");
    if (executionMode === "edit") expect(tools[0].parameters.properties).toHaveProperty("reference_sections");
  });

  it("Chat has a dedicated system prompt and no editable blocks", () => {
    const prompt = buildPrompt({ ...turn, task: "answer" });
    expect(prompt.system).toContain("Paper Chat Module");
    expect(prompt.system).toContain("Never output edit blocks");
    expect(prompt.messages[0].content).toContain("Exact paper source.");
    expect(prompt.messages.at(-1)?.content).toContain(turn.refinedQuestion);
    expect(prompt.messages.at(-1)?.content).not.toContain("<<<<<<< ORIGINAL");
  });

  it("Edit sees summaries, full sources, both requests and its editable targets", () => {
    const prompt = buildPrompt({ ...turn, task: "edit", editSections: ["3"] });
    expect(prompt.system).toContain("Paper Edit Module");
    expect(prompt.system).toContain("read-only references");
    expect(prompt.messages[0].content).toContain("Exact paper source.");
    const last = prompt.messages.at(-1)!.content;
    for (const value of [turn.instruction, turn.refinedQuestion!, "A summary of method.", "<editable_sections>\n3\n</editable_sections>"]) expect(last).toContain(value);
    expect(EDIT_TOOLS[0].name).toBe("apply_paper_edits");
  });

  it("retains session summary before recent history and the task after the source", () => {
    const prompt = buildPrompt({ ...turn, task: "edit", editSections: ["3"] });
    const first = prompt.messages[0].content;
    expect(first.indexOf("</paper>")).toBeLessThan(first.indexOf("<session_summary>"));
    expect(first.indexOf("<session_summary>")).toBeLessThan(first.indexOf("Section 3 is too long."));
    expect(prompt.system).toContain("[answer stopped by the user]");
  });

  it("offers editing tools in both providers' strict function-call formats", () => {
    const request: AIRequest = { ...turn, task: "edit", tools: EDIT_TOOLS };
    const openai = new OpenAIProvider(() => "api_key").buildBody(request);
    const anthropic = new AnthropicProvider().buildBody(request);
    expect(openai.tool_choice).toBe("required");
    expect(openai.parallel_tool_calls).toBe(false);
    expect((openai.tools as { strict: boolean }[]).every((t) => t.strict)).toBe(true);
    expect(anthropic.tool_choice).toMatchObject({ type: "auto", disable_parallel_tool_use: true });
  });

  it("keeps the inline selection rule specific to inline editing", () => {
    expect(buildPrompt({ ...turn, task: "inline-edit" }).system).toContain("Only edit the selected text.");
    expect(buildPrompt({ ...turn, task: "edit" }).system).not.toContain("Only edit the selected text.");
  });
});
