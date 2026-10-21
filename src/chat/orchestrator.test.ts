import { describe, expect, it } from "vitest";
import { AIError } from "../ai/errors";
import type { ChatRequest, GatewayOptions, GatewayResult } from "../ai/gateway";
import { CHAT_MODELS } from "../ai/models/modelConfig";
import type { AIResponse, ChatTask, ToolCall } from "../ai/types";
import { buildPrompt } from "../ai/prompts";
import { startSpan } from "../debug/trace";
import { buildPaperDocument } from "../latex/parser/documentModel";
import { samplePaper } from "../test/samplePaper";
import { askedForSections, chooseRoute, conversationFor, runChatTurn, type Paper, type Stage, type Turn } from "./orchestrator";
import { FRONT, paperUnits } from "./paper/sections";
import { addUnresolved, emptySummary } from "./session/summary";
import type { TurnRecord } from "./session/turns";

const response = (text: string, toolCalls?: ToolCall[]): AIResponse => ({
  id: "r",
  provider: "openai",
  model: "gpt-6.1-sol",
  text,
  ...(toolCalls ? { toolCalls } : {}),
  finishReason: "stop",
});
const tool = (name: string, reason = "because"): ToolCall[] => [{ id: "c1", name, arguments: { reason } }];

type Reply = (request: ChatRequest, options: GatewayOptions) => AIResponse;

/** A fake LLM Gateway: one scripted reply per task, and a log of what each call received. */
function gateway(replies: Partial<Record<ChatTask, Reply>>) {
  const log: { task: ChatTask; request: ChatRequest; options: GatewayOptions }[] = [];
  const call = async (task: ChatTask, request: ChatRequest, options: GatewayOptions): Promise<GatewayResult> => {
    log.push({ task, request, options });
    const choice = CHAT_MODELS[task].primary;
    options.onAttempt?.(choice, false);
    const out = replies[task];
    if (!out) throw new Error(`unexpected ${task} call`);
    return { response: out(request, options), choice };
  };
  return { call, log };
}

const turn: Turn = {
  id: "t1",
  instruction: "이 논문 핵심이 뭐야?",
  context: { currentFile: "main.tex" },
  turns: [{ index: 1, question: "hi", answer: "hello", status: "done" }],
  activePath: "main.tex",
};
const history = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];
const paper: Paper = { files: [{ path: "main.tex", text: "\\section{Method} We route tokens." }], omitted: [], budget: 1000 };

function run(replies: Partial<Record<ChatTask, Reply>>, inputTurn: Turn = turn, inputPaper: Paper = paper) {
  const { call, log } = gateway(replies);
  const stages: Stage[] = [];
  const refined: string[] = [];
  const text: string[] = [];
  let paperReads = 0;
  const result = runChatTurn(inputTurn, {
    root: startSpan("t1", null, "pipeline", "test"),
    control: { stopped: false, activeRequest: null },
    paper: () => {
      paperReads++;
      return inputPaper;
    },
    call: call as never,
    hooks: { onStage: (s) => stages.push(s), onRefined: (q) => refined.push(q), onText: (t) => text.push(t) },
  });
  return { result, log, stages, refined, text, reads: () => paperReads };
}

describe("conversationFor", () => {
  const many: TurnRecord[] = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, question: `q${i + 1}`, answer: `a${i + 1}`, status: "done" }));
  const at = (turns: TurnRecord[], coveredTurns: number): Turn => ({
    ...turn,
    turns,
    summary: coveredTurns ? { ...addUnresolved(emptySummary(), []), coveredTurns, goal: "Tighten section 4" } : null,
  });

  it("has no turns before the first answer", () => {
    expect(conversationFor({ ...turn, turns: [] }, "judge").info).toEqual({ turn_numbers: [] });
  });

  it("gives the judge the last four turns, and the modules the turns the summary does not cover", () => {
    const t = at(many, 4);
    expect(conversationFor(t, "judge").info.turn_numbers).toEqual([3, 4, 5, 6]);
    expect(conversationFor(t, "module").info.turn_numbers).toEqual([5, 6]);
    expect(conversationFor(t, "module").history.map((m) => m.content)).toEqual(["q5", "a5", "q6", "a6"]);
    expect(conversationFor(t, "module").sessionSummary).toContain("Goal: Tighten section 4");
    expect(conversationFor(at(many, 0), "module").info.turn_numbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(conversationFor(at(many, 0), "judge").info.turn_numbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("cuts long messages harder for the modules than for the judge", () => {
    const long: TurnRecord[] = [{ index: 1, question: "x".repeat(6000), answer: "ok", status: "done" }];
    expect(conversationFor({ ...turn, turns: long }, "judge").info.clipped).toBeUndefined();
    expect(conversationFor({ ...turn, turns: long }, "module").info.clipped).toEqual([{ turn: 1, role: "user", original_chars: 6000 }]);
  });
});

describe("chooseRoute", () => {
  it("follows the tool the judge called", () => {
    expect(chooseRoute(response("", tool("answer_question", "names Table 2")))).toEqual({ route: "answer", reason: "names Table 2" });
    expect(chooseRoute(response("", tool("refine_question")))).toEqual({ route: "refine", reason: "because" });
    expect(chooseRoute(response("", tool("reply_directly", "a thank-you, not a question")))).toEqual({ route: "reply", reason: "a thank-you, not a question" });
  });
  it("keeps the route when the arguments are broken, and reports why the reason is missing", () => {
    const broken = response("", [{ id: "c1", name: "answer_question", arguments: {}, argumentsError: "invalid_json" }]);
    expect(chooseRoute(broken)).toEqual({ route: "answer", reasonIssue: "arguments_unreadable" });
    const empty = response("", [{ id: "c1", name: "reply_directly", arguments: { reason: "  " } }]);
    expect(chooseRoute(empty)).toEqual({ route: "reply", reasonIssue: "reason_missing" });
  });
  it("reads text without a tool call as small talk", () => {
    expect(chooseRoute(response("You're welcome."))).toEqual({ route: "reply" });
  });
  it("prefers the tool when the judge also wrote text", () => {
    expect(chooseRoute(response("Let me check.", tool("answer_question"))).route).toBe("answer");
  });
  it("refines when the reply is empty or the tool is unknown", () => {
    expect(chooseRoute(response("  ")).route).toBe("refine");
    expect(chooseRoute(response("", tool("search_web"))).route).toBe("refine");
  });
});

describe("Chat Orchestrator", () => {
  it.each(["reply", "answer", "refine"] as const)("passes the selected history and its turn numbers along the %s route", async (route) => {
    const turns: TurnRecord[] = Array.from({ length: 9 }, (_, i) => ({ index: i + 1, question: `q${i + 1}`, answer: `a${i + 1}`, status: "done" }));
    const r = run({
      judge: () => response("", tool(route === "reply" ? "reply_directly" : route === "answer" ? "answer_question" : "refine_question")),
      reply: () => response("ok"),
      refine: () => response('{"refined_question":"A clearer question"}'),
      answer: () => response("ok"),
    }, { ...turn, turns, summary: { ...emptySummary(), coveredTurns: 7, goal: "Keep the context" } });
    await r.result;
    for (const { task, request, options } of r.log) {
      const expected = task === "judge" ? [6, 7, 8, 9] : [8, 9];
      expect(request.history?.map((m) => m.content)).toEqual(expected.flatMap((i) => [`q${i}`, `a${i}`]));
      expect(options.trace?.input).toEqual({ turn_numbers: expected });
      expect(request.sessionSummary).toContain("Keep the context");
    }
  });

  it("A: small talk goes to the Reply Module, with two model calls and without the paper", async () => {
    const r = run({
      judge: () => response("", tool("reply_directly", "a thank-you, not a question about the paper")),
      reply: (_req, options) => {
        options.onText?.("천만에요!");
        return response(" 천만에요! ");
      },
    });
    const result = await r.result;
    expect(result).toMatchObject({
      route: "reply",
      outcome: "reply",
      reason: "a thank-you, not a question about the paper",
      content: "천만에요!",
      choice: CHAT_MODELS.reply.primary,
    });
    expect(r.log.map((c) => c.task)).toEqual(["judge", "reply"]);
    const reply = r.log[1].request;
    expect(reply.instruction).toBe(turn.instruction);
    expect(reply.history).toEqual(history);
    expect(reply.projectFiles).toBeUndefined();
    expect(reply.paperView).toBeUndefined();
    expect(reply.tools).toBeUndefined();
    // Read once, for the judge's paper map.
    expect(r.reads()).toBe(1);
    expect(r.text).toEqual(["천만에요!"]);
    expect(r.stages).toEqual(["judge", "reply"]);
  });

  it("gives the judge the three route tools, the message and the conversation, but not the paper", async () => {
    const r = run({ judge: () => response("", tool("reply_directly")), reply: () => response("hi") });
    await r.result;
    const judge = r.log[0].request;
    expect(judge.tools?.map((t) => t.name)).toEqual(["reply_directly", "answer_question", "refine_question"]);
    expect(judge.tools?.map((t) => (t.parameters as { required: string[] }).required)).toEqual([["reason"], ["reason", "sections"], ["reason", "sections"]]);
    expect(judge.instruction).toBe(turn.instruction);
    expect(judge.history).toEqual(history);
    expect(judge.projectFiles).toBeUndefined();
  });

  it("B: answers a clear question directly, with two model calls", async () => {
    const r = run({
      judge: () => response("", tool("answer_question")),
      answer: (_req, options) => {
        options.onText?.("Table 2");
        options.onText?.("Table 2 shows…");
        return response("Table 2 shows…");
      },
    });
    const result = await r.result;
    expect(result).toMatchObject({ route: "answer", outcome: "answer", content: "Table 2 shows…", reason: "because" });
    expect(result.refined).toBeUndefined();
    expect(r.log.map((c) => c.task)).toEqual(["judge", "answer"]);
    const answer = r.log[1].request;
    expect(answer.projectFiles).toEqual(paper.files);
    expect(answer.refinedQuestion).toBeUndefined();
    expect(answer.instruction).toBe(turn.instruction);
    expect(r.text).toEqual(["Table 2", "Table 2 shows…"]);
    expect(r.stages).toEqual(["judge", "answer"]);
  });

  it("C: refines an abstract question, then answers with both questions, with three model calls", async () => {
    const r = run({
      judge: () => response("", tool("refine_question", "too broad")),
      refine: () => response('{"refined_question":"이 논문이 제안한 방법의 핵심 아이디어를 요약해 달라"}'),
      answer: () => response("핵심은 …"),
    });
    const result = await r.result;
    expect(result).toMatchObject({ route: "refine", outcome: "answer", refined: "이 논문이 제안한 방법의 핵심 아이디어를 요약해 달라", content: "핵심은 …" });
    expect(r.log.map((c) => c.task)).toEqual(["judge", "refine", "answer"]);
    const [, refine, answer] = r.log.map((c) => c.request);
    expect(refine.projectFiles).toEqual(paper.files);
    expect(refine.history).toEqual(history);
    expect(answer.refinedQuestion).toBe("이 논문이 제안한 방법의 핵심 아이디어를 요약해 달라");
    expect(answer.instruction).toBe(turn.instruction);
    // Both modules get the same paper, read once.
    expect(answer.projectFiles).toBe(refine.projectFiles);
    expect(r.reads()).toBe(1);
    expect(r.refined).toEqual(["이 논문이 제안한 방법의 핵심 아이디어를 요약해 달라"]);
    expect(r.stages).toEqual(["judge", "refine", "answer"]);
  });

  it("C: asks the user back when the Refine Module cannot settle the question", async () => {
    const r = run({
      judge: () => response("", tool("refine_question")),
      refine: () => response('{"clarify":"어느 표를 말씀하시는 건가요?"}'),
    });
    const result = await r.result;
    expect(result).toMatchObject({ route: "refine", outcome: "clarify", content: "어느 표를 말씀하시는 건가요?" });
    expect(r.log.map((c) => c.task)).toEqual(["judge", "refine"]);
    expect(r.stages).toEqual(["judge", "refine"]);
  });

  it("stops at the step that failed", async () => {
    const { call } = gateway({ judge: () => response("", tool("refine_question")) });
    const failing = async (task: ChatTask, request: ChatRequest, options: GatewayOptions) => {
      if (task === "refine") throw new AIError("unavailable", "down");
      return call(task, request, options);
    };
    await expect(
      runChatTurn(turn, { root: startSpan("t2", null, "pipeline", "test"), control: { stopped: false, activeRequest: null }, paper: () => paper, call: failing as never, hooks: {} }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("reports the model that wrote the answer, and the fallback", async () => {
    const claude = CHAT_MODELS.answer.fallback;
    const r = runChatTurn(turn, {
      root: startSpan("t3", null, "pipeline", "test"),
      control: { stopped: false, activeRequest: null },
      paper: () => paper,
      hooks: {},
      call: (async (task: ChatTask) =>
        task === "judge"
          ? { response: response("", tool("answer_question")), choice: CHAT_MODELS.judge.primary }
          : { response: response("from Claude"), choice: claude, fallbackFrom: { choice: CHAT_MODELS.answer.primary, error: new AIError("unavailable", "down") } }) as never,
    });
    expect(await r).toMatchObject({ content: "from Claude", choice: claude, fallbackFrom: CHAT_MODELS.answer.primary });
  });
});

describe("askedForSections", () => {
  it("reads the sections an answer asked for instead of answering", () => {
    expect(askedForSections("[[need_sections: 3.2, 4]]")).toEqual(["3.2", "4"]);
    expect(askedForSections("\n [[need_sections:]]")).toEqual([]);
    expect(askedForSections("Table 2 shows [[need_sections: 4]]")).toBeNull();
  });
});

describe("reading the paper by sections", () => {
  const files = samplePaper();
  const { units, macros } = paperUnits(buildPaperDocument({ files }), files);
  const summaries = new Map(units.filter((u) => u.key !== FRONT).map((u) => [u.key, `Summary of ${u.title}.`]));
  const sectioned = (known = summaries): Paper => ({ files: [...files].map(([path, text]) => ({ path, text })), omitted: [], budget: 150_000, units, summaries: known, macros });
  const pick = (name: string, sections: string[]): ToolCall[] => [{ id: "c1", name, arguments: { reason: "because", sections } }];
  const contents = (request: ChatRequest) => Object.fromEntries((request.paperView?.sections ?? []).map((s) => [s.key, s.content]));

  it("reads the judge's sections from its tool call", () => {
    expect(chooseRoute(response("", [{ id: "c1", name: "answer_question", arguments: { reason: "r", sections: ["3.2", 7] } }]))).toEqual({ route: "answer", reason: "r", sections: ["3.2"] });
    expect(chooseRoute(response("", pick("reply_directly", ["1"]))).sections).toBeUndefined();
  });

  it("gives the judge the paper map, and reads the whole paper while the report has no summaries", async () => {
    const r = run({ judge: () => response("", pick("answer_question", ["3.2"])), answer: () => response("ok") }, turn, sectioned(new Map()));
    await r.result;
    const [judge, answer] = r.log.map((c) => c.request);
    expect(judge.paperMap?.map((e) => e.key)).toEqual(units.map((u) => u.key));
    expect(judge.paperMap?.find((e) => e.key === FRONT)?.always).toBe(true);
    const prompt = buildPrompt({ ...judge, task: "judge", model: "m" }).messages[0].content;
    expect(prompt).toContain('<paper_map summaries="none">');
    expect(prompt).toContain("  [3.2] Uncertainty Estimation (");
    expect(answer.projectFiles?.map((f) => f.path)).toEqual([...files.keys()]);
    expect(answer.paperView).toBeUndefined();
    expect(answer.mayAskForSections).toBeUndefined();
  });

  it("reads the sections the judge chose word for word, with their subsections, and the rest as summaries", async () => {
    const r = run({ judge: () => response("", pick("answer_question", ["3"])), answer: () => response("ok") }, turn, sectioned());
    await r.result;
    const [judge, answer] = r.log.map((c) => c.request);
    expect(buildPrompt({ ...judge, task: "judge", model: "m" }).messages[0].content).toContain("[3.2] Uncertainty Estimation (");
    expect(answer.projectFiles).toBeUndefined();
    expect(contents(answer)).toMatchObject({ [FRONT]: "full", "3": "full", "3.1": "full", "3.2": "full", "3.3": "full", "1": "summary", "4.3": "summary" });
    expect(answer.paperView?.macros).toBe(macros);
    expect(answer.mayAskForSections).toBe(true);
    const sent = buildPrompt({ ...answer, task: "answer", model: "m" });
    expect(sent.messages[0].content).toContain('<section key="1" title="Introduction" content="summary">\nSummary of Introduction.\n</section>');
    expect(sent.messages[0].content).toContain('<section key="3.2" title="Uncertainty Estimation" content="full">\n<source file="sections/method.tex" lines="9-');
    expect(sent.messages.at(-1)!.content).toContain("[[need_sections: key, key]]");
  });

  it("reads a section without a summary word for word, and the whole paper when the judge asks for all", async () => {
    const partial = new Map(summaries);
    partial.delete("4.2");
    const r = run({ judge: () => response("", pick("answer_question", [])), answer: () => response("ok") }, turn, sectioned(partial));
    await r.result;
    expect(contents(r.log[1].request)).toMatchObject({ [FRONT]: "full", "4.2": "full", "4.1": "summary" });

    const all = run({ judge: () => response("", pick("answer_question", ["all"])), answer: () => response("ok") }, turn, sectioned());
    await all.result;
    expect(all.log[1].request.projectFiles).toHaveLength(files.size);
    expect(all.log[1].request.paperView).toBeUndefined();
  });

  it("lets the Refine Module correct the judge's sections", async () => {
    const r = run({
      judge: () => response("", pick("refine_question", ["1"])),
      refine: () => response('{"refined_question":"What does Table 1 report?","sections":["4.3"]}'),
      answer: () => response("ok"),
    }, turn, sectioned());
    await r.result;
    const [, refine, answer] = r.log.map((c) => c.request);
    expect(contents(refine)).toMatchObject({ "1": "full", "4.3": "summary" });
    expect(buildPrompt({ ...refine, task: "refine", model: "m" }).messages.at(-1)!.content).toContain('"sections":["..."]');
    expect(contents(answer)).toMatchObject({ "1": "summary", "4.3": "full" });
  });

  it("asks once for sections the answer has only as summaries, without showing the request", async () => {
    let answers = 0;
    const r = run({
      judge: () => response("", pick("answer_question", [])),
      answer: (_req, options) => {
        if (answers++ === 0) {
          options.onText?.("[[need");
          options.onText?.("[[need_sections: 4.3]]");
          return response("[[need_sections: 4.3]]");
        }
        options.onText?.("Table 1 shows MPJPE.");
        return response("Table 1 shows MPJPE.");
      },
    }, turn, sectioned());
    const result = await r.result;
    expect(result.content).toBe("Table 1 shows MPJPE.");
    expect(r.text).toEqual(["Table 1 shows MPJPE."]);
    expect(r.log.map((c) => c.task)).toEqual(["judge", "answer", "answer"]);
    const second = r.log[2].request;
    expect(contents(second)).toMatchObject({ "4.3": "full", "4.2": "summary" });
    expect(second.mayAskForSections).toBeUndefined();
    expect(buildPrompt({ ...second, task: "answer", model: "m" }).messages.at(-1)!.content).not.toContain("[[need_sections:");
  });

  it("shows an answer that only began like a request for sections", async () => {
    const r = run({
      judge: () => response("", pick("answer_question", [])),
      answer: (_req, options) => {
        options.onText?.("[[");
        return response("[[");
      },
    }, turn, sectioned());
    expect((await r.result).content).toBe("[[");
    expect(r.text).toEqual(["[["]);
    expect(r.log.map((c) => c.task)).toEqual(["judge", "answer"]);
  });
});
