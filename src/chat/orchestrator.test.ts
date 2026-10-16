import { describe, expect, it } from "vitest";
import { AIError } from "../ai/errors";
import type { ChatRequest, GatewayOptions, GatewayResult } from "../ai/gateway";
import { CHAT_MODELS } from "../ai/models/modelConfig";
import type { AIResponse, ChatTask, ToolCall } from "../ai/types";
import { startSpan } from "../debug/trace";
import { chooseRoute, runChatTurn, turnCount, type Stage, type Turn } from "./orchestrator";

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
  const log: { task: ChatTask; request: ChatRequest }[] = [];
  const call = async (task: ChatTask, request: ChatRequest, options: GatewayOptions): Promise<GatewayResult> => {
    log.push({ task, request });
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
  history: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ],
  activePath: "main.tex",
};
const paper = { files: [{ path: "main.tex", text: "\\section{Method} We route tokens." }], omitted: [], budget: 1000 };

function run(replies: Partial<Record<ChatTask, Reply>>) {
  const { call, log } = gateway(replies);
  const stages: Stage[] = [];
  const refined: string[] = [];
  const text: string[] = [];
  let paperReads = 0;
  const result = runChatTurn(turn, {
    root: startSpan("t1", null, "pipeline", "test"),
    control: { stopped: false, activeRequest: null },
    paper: () => {
      paperReads++;
      return paper;
    },
    call: call as never,
    hooks: { onStage: (s) => stages.push(s), onRefined: (q) => refined.push(q), onText: (t) => text.push(t) },
  });
  return { result, log, stages, refined, text, reads: () => paperReads };
}

describe("turnCount", () => {
  it("counts finished question and answer exchanges", () => {
    expect(turnCount([])).toBe(0);
    expect(turnCount(turn.history)).toBe(1);
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
    expect(reply.history).toEqual(turn.history);
    expect(reply.projectFiles).toBeUndefined();
    expect(reply.tools).toBeUndefined();
    expect(r.reads()).toBe(0);
    expect(r.text).toEqual(["천만에요!"]);
    expect(r.stages).toEqual(["judge", "reply"]);
  });

  it("gives the judge the three route tools, the message and the conversation, but not the paper", async () => {
    const r = run({ judge: () => response("", tool("reply_directly")), reply: () => response("hi") });
    await r.result;
    const judge = r.log[0].request;
    expect(judge.tools?.map((t) => t.name)).toEqual(["reply_directly", "answer_question", "refine_question"]);
    for (const t of judge.tools ?? []) expect(t.parameters).toMatchObject({ required: ["reason"] });
    expect(judge.instruction).toBe(turn.instruction);
    expect(judge.history).toEqual(turn.history);
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
    expect(refine.history).toEqual(turn.history);
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
