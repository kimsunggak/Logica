import { describe, expect, it } from "vitest";
import { AIError } from "../ai/errors";
import type { ChatRequest, GatewayOptions, GatewayResult } from "../ai/gateway";
import { CHAT_MODELS } from "../ai/models/modelConfig";
import type { AIResponse, ChatMode, ChatTask } from "../ai/types";
import { startSpan } from "../debug/trace";
import { buildPaperDocument } from "../latex/parser/documentModel";
import { samplePaper } from "../test/samplePaper";
import { chooseRoute, conversationFor, runChatTurn, type Paper, type Stage, type Turn } from "./orchestrator";
import { FRONT, paperUnits } from "./paper/sections";
import { emptySummary } from "./session/summary";
import type { TurnRecord } from "./session/turns";

const response = (text: string): AIResponse => ({ id: "r", provider: "openai", model: "gpt-6.1-sol", text, finishReason: "stop" });
const tool = (name: string, args: Record<string, unknown> = { reason: "because" }): AIResponse => ({ ...response(""), toolCalls: [{ id: "c1", name, arguments: args }] });
const tex = samplePaper();
const paper: Paper = {
  files: [...tex].map(([path, text]) => ({ path, text })), omitted: [], budget: 150000,
  ...paperUnits(buildPaperDocument({ files: tex }), tex),
};
paper.summaries = new Map(paper.units!.filter((u) => u.key !== FRONT).map((u) => [u.key, "Summary of " + u.title]));
const target = paper.units!.find((u) => u.key === "3.2")!.sources[0];
const edit = { path: target.path, original: target.text, revised: target.text + "\n% revised" };
const editSelection = () => tool("select_edit_sections", { reason: "Shorten the method using introduction as reference", edit_sections: ["3.2"], reference_sections: ["1"] });
type Reply = (request: ChatRequest, options: GatewayOptions) => AIResponse;
const turn: Turn = { id: "t1", instruction: "Shorten section 3.2", turns: [] };
function run(mode: ChatMode, replies: Partial<Record<ChatTask, Reply>> = {}, inputPaper = paper, inputTurn = turn) {
  const log: { task: ChatTask; request: ChatRequest; options: GatewayOptions }[] = [];
  const defaults: Partial<Record<ChatTask, Reply>> = {
    refine: () => response(inputTurn.instruction),
    judge: () => tool(mode === "auto" && replies.edit ? "route_edit" : "route_chat"),
    select: mode === "edit" || replies.edit ? editSelection : () => tool("select_chat_sections", { reason: "Read the method", sections: ["3.2"] }),
    answer: () => response("Answer from the paper."),
    edit: () => tool("apply_paper_edits", { summary: "Proposed changes.", edits: [edit] }),
  };
  const stages: Stage[] = [], text: string[] = [], refined: string[] = [];
  const call = async (task: ChatTask, request: ChatRequest, options: GatewayOptions): Promise<GatewayResult> => {
    log.push({ task, request, options });
    const choice = CHAT_MODELS[task].primary;
    options.onAttempt?.(choice, false);
    return { response: (replies[task] ?? defaults[task]!)(request, options), choice };
  };
  const result = runChatTurn({ ...inputTurn, mode }, {
    root: startSpan(inputTurn.id, null, "pipeline", "test"), control: { stopped: false, activeRequest: null }, paper: () => inputPaper,
    call, hooks: { onStage: (s) => stages.push(s), onText: (s) => text.push(s), onRefined: (s) => refined.push(s) },
  });
  return { result, log, stages, text, refined };
}

describe("conversationFor", () => {
  const turns: TurnRecord[] = Array.from({ length: 9 }, (_, i) => ({ index: i + 1, question: "q" + (i + 1), answer: "a" + (i + 1), status: "done" }));
  it.each(["judge", "module"] as const)("keeps four recent turns and every unsummarized turn for %s", (reader) => {
    expect(conversationFor({ ...turn, turns, summary: { ...emptySummary(), coveredTurns: 7 } }, reader).info.turn_numbers).toEqual([6, 7, 8, 9]);
    expect(conversationFor({ ...turn, turns, summary: { ...emptySummary(), coveredTurns: 3 } }, reader).info.turn_numbers).toEqual([4, 5, 6, 7, 8, 9]);
  });
  it("preserves the session summary and reports clipped module messages", () => {
    const input: Turn = { ...turn, turns: [{ index: 1, question: "x".repeat(6000), answer: "ok", status: "done" }], summary: { ...emptySummary(), goal: "Keep references" } };
    expect(conversationFor(input, "module").sessionSummary).toContain("Keep references");
    expect(conversationFor(input, "module").info.clipped).toEqual([{ turn: 1, role: "user", original_chars: 6000 }]);
    expect(conversationFor(input, "judge").info.clipped).toBeUndefined();
  });
});

describe("Auto intent routing", () => {
  it.each(["chat", "edit"] as const)("recognizes route_%s", (route) => expect(chooseRoute(tool("route_" + route))).toMatchObject({ route, reason: "because" }));
  it("uses an explicit clarification question", () => expect(chooseRoute(tool("clarify_request", { question: "Discuss or change?" }))).toMatchObject({ route: "clarify", question: "Discuss or change?" }));
  it("clarifies for invalid, missing, multiple or truncated calls", () => {
    for (const input of [
      response("edit"), tool("unknown"), { ...tool("route_edit"), finishReason: "length" as const },
      { ...tool("route_edit"), toolCalls: [...tool("route_edit").toolCalls!, ...tool("route_chat").toolCalls!] },
      { ...tool("route_edit"), toolCalls: [{ id: "x", name: "route_edit", arguments: {}, argumentsError: "invalid_json" as const }] },
    ]) expect(chooseRoute(input).route).toBe("clarify");
  });
});

describe("Refinement → Routing → Execution", () => {
  it("always refines Chat, then selects sources and answers without intent classification", async () => {
    const r = run("chat");
    expect(await r.result).toMatchObject({ route: "chat", outcome: "chat" });
    expect(r.log.map((c) => c.task)).toEqual(["refine", "select", "answer"]);
    expect(r.stages).toEqual(["refine", "select", "answer"]);
    expect(r.log[0].request.paperMap).toBeUndefined();
    expect(r.log[0].request.paperView).toBeUndefined();
    expect(r.log[2].request.tools).toBeUndefined();
  });

  it("always refines Edit, independently selects writable/reference sections, then returns a queued tool call", async () => {
    const r = run("edit");
    const result = await r.result;
    expect(result).toMatchObject({ route: "edit", outcome: "edit", content: "Proposed changes.", editToolCallId: "c1", edits: [edit] });
    expect(r.log.map((c) => c.task)).toEqual(["refine", "select", "edit"]);
    const request = r.log[2].request;
    expect(request.editSections).toEqual(["3.2"]);
    expect(request.paperMap?.find((s) => s.key === "4.3")?.summary).toBeDefined();
    expect(Object.fromEntries(request.paperView!.sections.map((s) => [s.key, s.content]))).toMatchObject({ "3.2": "full", "1": "full", "4.3": "summary" });
    expect(request.tools?.map((t) => t.name)).toEqual(["apply_paper_edits", "clarify_request"]);
    expect(tex.get(target.path)).toContain(edit.original);
    expect(tex.get(target.path)).not.toContain("% revised");
  });

  it.each(["chat", "edit"] as const)("uses Auto only to choose %s and leaves source selection to execution preparation", async (route) => {
    const r = run("auto", { judge: () => tool("route_" + route), select: route === "edit" ? editSelection : () => tool("select_chat_sections", { reason: "Read source", sections: ["3.2"] }) });
    expect((await r.result).route).toBe(route);
    expect(r.log.map((c) => c.task)).toEqual(["refine", "judge", "select", route === "edit" ? "edit" : "answer"]);
    expect(r.log[1].request.tools?.[0].parameters.properties).not.toHaveProperty("sections");
  });

  it("passes original and refined requests, history and session summary to every later call", async () => {
    const input: Turn = { ...turn, instruction: "그렇게 줄이면 기여가 빠지지 않아?", turns: [{ index: 1, question: "q1", answer: "a1", status: "done" }], summary: { ...emptySummary(), goal: "Explain the method" } };
    const r = run("auto", { refine: () => response("Would shortening the method remove its contribution?") }, paper, input);
    await r.result;
    for (const call of r.log.slice(1)) {
      expect(call.request.instruction).toBe(input.instruction);
      expect(call.request.refinedQuestion).toBe("Would shortening the method remove its contribution?");
      expect(call.request.history).toEqual([{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }]);
      expect(call.request.sessionSummary).toContain("Explain the method");
    }
  });

  it("asks back when Auto intent is ambiguous without entering execution", async () => {
    const r = run("auto", { judge: () => tool("clarify_request", { question: "Discuss or edit?" }) });
    expect(await r.result).toMatchObject({ outcome: "clarify", content: "Discuss or edit?" });
    expect(r.log.map((c) => c.task)).toEqual(["refine", "judge"]);
  });

  it("asks back when the edit target is ambiguous", async () => {
    const r = run("edit", { select: () => tool("clarify_request", { question: "Which paragraph?" }) });
    expect(await r.result).toMatchObject({ route: "edit", outcome: "clarify", content: "Which paragraph?" });
    expect(r.log.map((c) => c.task)).toEqual(["refine", "select"]);
  });

  it("cannot turn a Chat response into an executable edit", async () => {
    const r = run("chat", { answer: () => tool("apply_paper_edits", { summary: "change", edits: [edit] }) });
    expect((await r.result).edits).toBeUndefined();
  });

  it("rejects unknown section keys and empty edit targets", async () => {
    for (const edit_sections of [["999"], []]) {
      const r = run("edit", { select: () => tool("select_edit_sections", { reason: "because", edit_sections, reference_sections: [] }) });
      await expect(r.result).rejects.toMatchObject({ kind: "malformed_response" });
      expect(r.log.map((c) => c.task)).not.toContain("edit");
    }
  });

  it("lets section selection choose only the paper map's keys, or all when the paper has no sections", async () => {
    const allowed = (r: ReturnType<typeof run>) => (r.log[1].request.tools![0].parameters.properties as Record<string, { items: { enum: string[] } }>).sections.items.enum;
    const r = run("chat");
    await r.result;
    expect(allowed(r)).toEqual(["all", ...paper.units!.map((u) => u.key)]);
    const bare = run("chat", { select: () => tool("select_chat_sections", { reason: "Read the paper", sections: ["all"] }) }, { ...paper, units: undefined, summaries: undefined });
    expect(await bare.result).toMatchObject({ outcome: "chat" });
    expect(allowed(bare)).toEqual(["all"]);
  });

  it("reads keys that differ from the paper's only in capitalization as the paper's keys", async () => {
    const r = run("edit", { select: () => tool("select_edit_sections", { reason: "because", edit_sections: ["3.2"], reference_sections: ["Metadata", "ABSTRACT"] }) });
    expect(await r.result).toMatchObject({ outcome: "edit" });
    expect(Object.fromEntries(r.log[2].request.paperView!.sections.map((s) => [s.key, s.content]))).toMatchObject({ metadata: "full", abstract: "full", "3.2": "full" });
    const all = run("chat", { select: () => tool("select_chat_sections", { reason: "because", sections: ["All"] }) });
    await all.result;
    expect(all.log[2].request.projectFiles).toBeDefined();
  });

  it("requires all selected edit and reference sources to fit", async () => {
    const r = run("edit", {}, { ...paper, budget: 1 });
    await expect(r.result).rejects.toMatchObject({ kind: "bad_request" });
    expect(r.log.map((c) => c.task)).not.toContain("edit");
  });

  it("rejects changes to a full section that was supplied only for reference", async () => {
    const ref = paper.units!.find((u) => u.key === "1")!.sources[0];
    const r = run("edit", { edit: () => tool("apply_paper_edits", { summary: "change", edits: [{ path: ref.path, original: ref.text, revised: ref.text + "changed" }] }) });
    await expect(r.result).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("does not expose truncated edit tool arguments as applicable proposals", async () => {
    const r = run("edit", { edit: () => ({ ...tool("apply_paper_edits", { summary: "change", edits: [edit] }), finishReason: "length" }) });
    await expect(r.result).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("stops before routing if refinement fails or is truncated", async () => {
    const r = run("auto", { refine: () => ({ ...response("partial"), finishReason: "length" }) });
    await expect(r.result).rejects.toMatchObject({ kind: "malformed_response" });
    expect(r.log.map((c) => c.task)).toEqual(["refine"]);
  });

  it("propagates cancellation", async () => {
    const r = run("edit", { select: () => { throw new AIError("cancelled", "stopped"); } });
    await expect(r.result).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("loads additional full sections once when Chat needs exact source", async () => {
    let count = 0;
    const r = run("chat", { answer: (request, options) => {
      count++;
      if (request.mayAskForSections) { options.onText?.("[[need_sections: 4.3]]"); return response("[[need_sections: 4.3]]"); }
      expect(request.paperView?.sections.find((s) => s.key === "4.3")?.content).toBe("full");
      options.onText?.("Detailed answer.");
      return response("Detailed answer.");
    } });
    expect((await r.result).content).toBe("Detailed answer.");
    expect(count).toBe(2);
    expect(r.text).toEqual(["Detailed answer."]);
  });
});
