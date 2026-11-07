import { describe, expect, it } from "vitest";
import { buildPrompt } from "./index";
import { CHAT_TOOLS, EDIT_TOOLS, editTools, sectionTools } from "../tools/chatTools";
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
    const tools = sectionTools(executionMode, ["3", "3.1"]);
    expect(tools[0].name).toBe(executionMode === "chat" ? "select_chat_sections" : "select_edit_sections");
    if (executionMode === "edit") expect(tools[0].parameters.properties).toHaveProperty("reference_sections");
  });

  it.each(["chat", "edit"] as const)("lets %s select only the paper map's keys or all", (executionMode) => {
    const lists = executionMode === "chat" ? ["sections"] : ["edit_sections", "reference_sections"];
    const allowed = (keys: string[]) => {
      const properties = sectionTools(executionMode, keys)[0].parameters.properties as Record<string, { items: { enum: string[] } }>;
      return lists.map((name) => properties[name].items.enum);
    };
    expect(allowed(["abstract", "3", "3.1"])).toEqual(lists.map(() => ["all", "abstract", "3", "3.1"]));
    expect(allowed([])).toEqual(lists.map(() => ["all"]));
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

});

describe("web research for Edit", () => {
  const evidence = [{ id: "W1", finding: "Paper A reaches 81.2 AP on OCHuman.", sources: [{ url: "https://example.org/a", title: "Paper A", quote: "81.2 AP" }] }];

  it("section selection decides on web research only when it is offered", () => {
    const plain = buildPrompt({ ...turn, task: "select", executionMode: "edit" });
    const offered = buildPrompt({ ...turn, task: "select", executionMode: "edit", mayResearch: true });
    expect(plain.system).not.toContain("web_research");
    expect(offered.system).toContain("In web_research, set needed to true only when");
    expect(offered.system.replace(/\nWeb search is on\.[^\n]*/, "")).toBe(plain.system);
    // Chat selection never decides on research.
    expect(buildPrompt({ ...turn, task: "select", executionMode: "chat", mayResearch: true }).system).not.toContain("web_research");
    const params = (research: boolean) => sectionTools("edit", ["3"], research)[0].parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params(false).properties).not.toHaveProperty("web_research");
    expect(params(true).required).toContain("web_research");
    expect(sectionTools("edit", ["3"])).toEqual(sectionTools("edit", ["3"], false));
  });

  it("the research reads the questions and the text to be edited, not the rest of the paper or the conversation", () => {
    const prompt = buildPrompt({
      ...turn, task: "research", researchQuestions: ["Latest OCHuman results?", "Who proposed PAFs?"],
      researchSources: [{ path: "sections/method.tex", fromLine: 3, toLine: 4, text: "We route frames." }],
    });
    const content = prompt.messages[0].content;
    expect(prompt.messages).toHaveLength(1);
    expect(content).toContain("<research_questions>\n1. Latest OCHuman results?\n2. Who proposed PAFs?\n</research_questions>");
    expect(content).toContain('<source file="sections/method.tex" lines="3-4">\nWe route frames.\n</source>');
    expect(content).toContain(turn.instruction);
    expect(content).not.toContain("Exact paper source.");
    expect(content).not.toContain("We could shorten it.");
    expect(prompt.system).toContain("Web Research Module");
    expect(prompt.system).toContain("NOT FOUND:");
  });

  it("the edit gets the evidence and gaps only when the research ran, and is unchanged otherwise", () => {
    const plain = buildPrompt({ ...turn, task: "edit", editSections: ["3"] });
    expect(buildPrompt({ ...turn, task: "edit", editSections: ["3"], webEvidence: [], researchGaps: [] })).toEqual(plain);
    const researched = buildPrompt({ ...turn, task: "edit", editSections: ["3"], webEvidence: evidence, researchGaps: ["The 2026 leaderboard"] });
    const last = researched.messages.at(-1)!.content;
    expect(last).toContain('<web_evidence>\n[W1] Paper A reaches 81.2 AP on OCHuman.\n  source: Paper A (https://example.org/a)\n  quote: "81.2 AP"\n</web_evidence>');
    expect(last).toContain("<research_gaps>\n- The 2026 leaderboard\n</research_gaps>");
    expect(researched.system).toContain("Facts from outside the paper may come only from these findings");
    expect(researched.system).toContain("Do not fill these gaps from memory");
    expect(plain.system).not.toContain("web_evidence");
  });

  it("each edit names the evidence it relies on only when there is evidence", () => {
    expect(editTools()).toBe(EDIT_TOOLS);
    expect(editTools([])).toBe(EDIT_TOOLS);
    const items = (tools: typeof EDIT_TOOLS) => ((tools[0].parameters as any).properties.edits.items as { properties: Record<string, any>; required: string[] });
    expect(items(EDIT_TOOLS).properties).not.toHaveProperty("evidence");
    const withIds = items(editTools(["W1", "W2"]));
    expect(withIds.properties.evidence.items.enum).toEqual(["W1", "W2"]);
    expect(withIds.required).toContain("evidence");
  });
});
