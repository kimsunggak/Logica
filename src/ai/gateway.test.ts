import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIError } from "./errors";
import type { AIRequest, AIResponse, ProviderId, StreamHandlers } from "./types";
import * as trace from "../debug/trace";

type Script = (request: AIRequest, handlers?: StreamHandlers) => Promise<AIResponse>;
const calls: { provider: ProviderId; request: AIRequest }[] = [];
let scripts: Partial<Record<ProviderId, Script>> = {};
let connected: Record<ProviderId, boolean> = { openai: true, anthropic: true };

vi.mock("./service", () => ({
  aiService: {
    generate: (provider: ProviderId, request: AIRequest, handlers?: StreamHandlers) => {
      calls.push({ provider, request });
      return scripts[provider]!(request, handlers);
    },
    isAuthenticated: async (provider: ProviderId) => connected[provider],
  },
}));

const { callModel } = await import("./gateway");

const reply = (provider: ProviderId, text: string): Script => async (request) => ({
  id: request.id,
  provider,
  model: request.model,
  text,
  finishReason: "stop",
});
const failing = (error: AIError): Script => async () => {
  throw error;
};
const control = () => ({ stopped: false, activeRequest: null as string | null });
const request = { id: "t1-refine", instruction: "q", context: {} };

beforeEach(() => {
  calls.length = 0;
  scripts = {};
  connected = { openai: true, anthropic: true };
});

describe("LLM Gateway", () => {
  it("reports the same turn numbers for primary and fallback model calls", async () => {
    scripts.anthropic = failing(new AIError("unavailable", "Claude is down", { provider: "anthropic" }));
    scripts.openai = reply("openai", "ok");
    const parent = trace.startSpan("history", null, "orchestrator", "test");
    const start = vi.spyOn(trace, "startSpan");
    try {
      await callModel("judge", request, {
        control: control(),
        trace: { traceId: "history", parent, input: { turn_numbers: [6, 7, 8, 9] } },
      });
      const inputs = start.mock.calls.filter(([, , , fn]) => fn === "aiService.generate").map(([, , , , input]) => typeof input === "function" ? input() : input);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toMatchObject({ task: "judge", fallback: false, turn_numbers: [6, 7, 8, 9] });
      expect(inputs[1]).toMatchObject({ task: "judge", fallback: true, turn_numbers: [6, 7, 8, 9] });
    } finally {
      start.mockRestore();
    }
  });

  it("uses the primary model and reasoning effort for each task", async () => {
    scripts.openai = reply("openai", "ok");
    scripts.anthropic = reply("anthropic", "ok");
    const judge = await callModel("judge", request, { control: control() });
    const refine = await callModel("refine", request, { control: control() });
    await callModel("select", request, { control: control() });
    await callModel("edit", request, { control: control() });
    expect(judge.choice).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "xhigh" });
    expect(refine.choice).toEqual({ provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" });
    expect(calls.map((c) => [c.request.task, c.request.model, c.request.reasoningEffort])).toEqual([
      ["judge", "claude-sonnet-5-5", "xhigh"],
      ["refine", "gpt-6.1-sol", "low"],
      ["select", "gpt-6.1-sol", "low"],
      ["edit", "gpt-6.1-sol", "medium"],
    ]);
    expect(judge.fallbackFrom).toBeUndefined();
  });

  it("falls back to GPT for judge when Claude fails, preserving tools", async () => {
    scripts.anthropic = failing(new AIError("unavailable", "Claude is down", { provider: "anthropic" }));
    scripts.openai = reply("openai", "ok");
    const { CHAT_TOOLS } = await import("./tools/chatTools");
    const result = await callModel("judge", { ...request, tools: CHAT_TOOLS }, { control: control() });
    expect(calls.map((c) => c.provider)).toEqual(["anthropic", "openai"]);
    expect(result.choice).toEqual({ provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" });
    expect(result.fallbackFrom?.choice.provider).toBe("anthropic");
    expect(calls[1].request.tools).toEqual(CHAT_TOOLS);
    expect(calls[1].request.reasoningEffort).toBe("low");
  });

  it("sends the same request to claude-sonnet-5-5 when OpenAI fails", async () => {
    scripts.openai = failing(new AIError("unavailable", "OpenAI is down", { provider: "openai", status: 503 }));
    scripts.anthropic = reply("anthropic", "from Claude");
    const attempts: string[] = [];
    const result = await callModel("refine", { ...request, history: [{ role: "user", content: "h" }] }, {
      control: control(),
      onAttempt: (choice, fallback) => attempts.push(`${choice.model}${fallback ? " (fallback)" : ""}`),
    });
    expect(result.response.text).toBe("from Claude");
    expect(result.choice).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(result.fallbackFrom?.error.message).toBe("OpenAI is down");
    expect(attempts).toEqual(["gpt-6.1-sol", "claude-sonnet-5-5 (fallback)"]);
    const [first, second] = calls;
    expect(second.provider).toBe("anthropic");
    expect(second.request.id).toBe("t1-refine-fallback");
    expect(second.request.reasoningEffort).toBeUndefined();
    expect(second.request.history).toEqual(first.request.history);
    expect(second.request.maxOutputTokens).toBe(first.request.maxOutputTokens);
  });

  it("falls back on any OpenAI failure, including a missing sign-in", async () => {
    scripts.openai = failing(new AIError("no_credential", "Sign in with ChatGPT", { provider: "openai" }));
    scripts.anthropic = reply("anthropic", "ok");
    expect((await callModel("refine", request, { control: control() })).choice.provider).toBe("anthropic");
  });

  it("does not fall back when the user stopped the turn", async () => {
    scripts.openai = failing(new AIError("cancelled", "Stopped", { provider: "openai" }));
    scripts.anthropic = reply("anthropic", "ok");
    await expect(callModel("answer", request, { control: control() })).rejects.toMatchObject({ kind: "cancelled" });
    expect(calls).toHaveLength(1);
  });

  it("reports a stop requested during the call as cancelled", async () => {
    const run = control();
    scripts.openai = async (req) => {
      run.stopped = true;
      return reply("openai", "late")(req);
    };
    await expect(callModel("answer", request, { control: run })).rejects.toMatchObject({ kind: "cancelled" });
    expect(run.activeRequest).toBeNull();
  });

  it("does not start a call after the turn was stopped", async () => {
    scripts.openai = reply("openai", "ok");
    await expect(callModel("refine", request, { control: { stopped: true, activeRequest: null } })).rejects.toMatchObject({ kind: "cancelled" });
    expect(calls).toHaveLength(0);
  });

  it("does not fall back once part of the answer is on screen", async () => {
    scripts.openai = async (_req, handlers) => {
      handlers?.onDelta?.("Part", "Part");
      throw new AIError("stream_interrupted", "cut off", { provider: "openai" });
    };
    scripts.anthropic = reply("anthropic", "ok");
    const shown: string[] = [];
    await expect(callModel("answer", request, { control: control(), onText: (t) => { shown.push(t); return true; } })).rejects.toMatchObject({
      kind: "stream_interrupted",
    });
    expect(shown).toEqual(["Part"]);
    expect(calls).toHaveLength(1);
  });

  it.each(["judge", "refine", "summary", "sections"] as const)("falls back after internal %s text fails without a display callback", async (task) => {
    const { primary, fallback } = (await import("./models/modelConfig")).CHAT_MODELS[task];
    scripts[primary.provider] = async (_req, handlers) => {
      handlers?.onDelta?.("internal", "internal");
      throw new AIError("stream_interrupted", "cut off", { provider: primary.provider });
    };
    scripts[fallback.provider] = reply(fallback.provider, "recovered");
    const result = await callModel(task, request, { control: control() });
    expect(result.response.text).toBe("recovered");
    expect(result.choice).toEqual(fallback);
    expect(calls.map((c) => c.provider)).toEqual([primary.provider, fallback.provider]);
  });

  it("falls back when the output callback reports that text was withheld", async () => {
    scripts.openai = async (_req, handlers) => {
      handlers?.onDelta?.("[[need", "[[need");
      throw new AIError("stream_interrupted", "cut off", { provider: "openai" });
    };
    scripts.anthropic = reply("anthropic", "recovered");
    const result = await callModel("answer", request, { control: control(), onText: () => false });
    expect(result.response.text).toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  it("remembers displayed output even when a later chunk is withheld", async () => {
    scripts.openai = async (_req, handlers) => {
      handlers?.onDelta?.("Part", "Part");
      handlers?.onDelta?.(" two", "Part two");
      throw new AIError("stream_interrupted", "cut off", { provider: "openai" });
    };
    scripts.anthropic = reply("anthropic", "recovered");
    await expect(callModel("answer", request, { control: control(), onText: (text) => text === "Part" })).rejects.toMatchObject({ kind: "stream_interrupted" });
    expect(calls).toHaveLength(1);
  });

  it("explains the error when Claude is not connected", async () => {
    connected.anthropic = false;
    scripts.openai = failing(new AIError("rate_limit", "Limit reached", { provider: "openai", status: 429 }));
    const error = await callModel("refine", request, { control: control() }).catch((e) => e);
    expect(error).toBeInstanceOf(AIError);
    expect(error.kind).toBe("rate_limit");
    expect(error.message).toContain("Limit reached");
    expect(error.message).toContain("Anthropic API key");
    expect(calls).toHaveLength(1);
  });

  it("reports both errors when Claude fails too", async () => {
    scripts.openai = failing(new AIError("unavailable", "OpenAI is down", { provider: "openai" }));
    scripts.anthropic = failing(new AIError("auth", "Claude key rejected", { provider: "anthropic", status: 401 }));
    const error = await callModel("answer", request, { control: control() }).catch((e) => e);
    expect(error.kind).toBe("auth");
    expect(error.message).toContain("OpenAI is down");
    expect(error.message).toContain("Claude also failed: Claude key rejected");
  });

  it("tracks the running request for cancellation", async () => {
    const run = control();
    let seen: string | null = null;
    scripts.openai = async (req) => {
      seen = run.activeRequest;
      return reply("openai", "ok")(req);
    };
    await callModel("answer", request, { control: run });
    expect(seen).toBe("t1-refine");
    expect(run.activeRequest).toBeNull();
  });
});
