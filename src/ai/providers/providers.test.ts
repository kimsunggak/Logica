import { describe, expect, it } from "vitest";
import type { AIRequest } from "../types";
import { AnthropicProvider } from "./anthropic/anthropicProvider";
import { OpenAIProvider } from "./openai/openaiProvider";
import { fromHttpError } from "../errors";

const request: AIRequest = {
  id: "r",
  task: "inline-edit",
  instruction: "Make concise",
  selectedText: "Some text.",
  context: { paperTitle: "T" },
  model: "model-x",
  maxOutputTokens: 1000,
};

describe("provider adapters", () => {
  it("OpenAI uses the Responses API format", () => {
    const body = new OpenAIProvider(() => "api_key").buildBody(request);
    expect(body).toMatchObject({ model: "model-x", stream: true, store: false, max_output_tokens: 1000 });
    expect(typeof body.instructions).toBe("string");
    expect((body.input as { role: string }[])[0].role).toBe("user");
  });
  it("OpenAI leaves out the output limit with Sign in with ChatGPT", () => {
    const body = new OpenAIProvider(() => "chatgpt").buildBody(request);
    expect(body).toMatchObject({ stream: true, store: false });
    expect(body).not.toHaveProperty("max_output_tokens");
  });
  it("Claude uses the Messages API format", () => {
    const body = new AnthropicProvider().buildBody(request);
    expect(body).toMatchObject({ model: "model-x", stream: true, max_tokens: 1000 });
    // The tools and system prompt end at a cache breakpoint.
    expect(body.system).toEqual([{ type: "text", text: expect.any(String), cache_control: { type: "ephemeral" } }]);
    expect((body.messages as { role: string }[])[0].role).toBe("user");
  });
});

describe("error mapping", () => {
  it("maps provider HTTP errors", () => {
    expect(fromHttpError("openai", 401).kind).toBe("auth");
    expect(fromHttpError("openai", 429, JSON.stringify({ error: { code: "insufficient_quota", message: "quota" } })).kind).toBe("quota");
    expect(fromHttpError("openai", 429).kind).toBe("rate_limit");
    expect(fromHttpError("anthropic", 529).kind).toBe("unavailable");
    expect(fromHttpError("anthropic", 404, JSON.stringify({ error: { type: "not_found_error", message: "model: x" } })).kind).toBe("model_unavailable");
    expect(fromHttpError("anthropic", 400, JSON.stringify({ error: { type: "invalid_request_error", message: "Your credit balance is too low" } })).kind).toBe("quota");
  });
});
