import { describe, expect, it } from "vitest";
import type { AIRequest } from "../types";
import { AnthropicProvider } from "./anthropic/anthropicProvider";
import { OpenAIProvider } from "./openai/openaiProvider";
import { fromHttpError } from "../errors";

const request: AIRequest = {
  id: "r",
  task: "answer",
  instruction: "Make concise",
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

describe("web search requests", () => {
  const answer: AIRequest = { ...request, task: "answer", instruction: "Related work?", reasoningEffort: "medium" };
  const fn = { name: "pick", description: "Pick one.", parameters: { type: "object", properties: {}, additionalProperties: false } };

  it("OpenAI offers the built-in search without forcing a tool call", () => {
    const on = new OpenAIProvider(() => "chatgpt").buildBody({ ...answer, webSearch: true });
    expect(on.tools).toEqual([{ type: "web_search" }]);
    expect(on).not.toHaveProperty("tool_choice");
    expect(on).not.toHaveProperty("parallel_tool_calls");
    const off = new OpenAIProvider(() => "chatgpt").buildBody({ ...answer, webSearch: false });
    expect(off).toEqual(new OpenAIProvider(() => "chatgpt").buildBody(answer));
    expect(off).not.toHaveProperty("tools");
  });

  it("OpenAI limits a Research call's searches with an API key only", () => {
    const research: AIRequest = { ...answer, task: "research", webSearch: true, maxSearches: 5 };
    expect(new OpenAIProvider(() => "api_key").buildBody(research)).toMatchObject({ tools: [{ type: "web_search" }], max_tool_calls: 5 });
    // Whether ChatGPT plan usage accepts the limit is not known.
    expect(new OpenAIProvider(() => "chatgpt").buildBody(research)).not.toHaveProperty("max_tool_calls");
    // No limit without one, or without search.
    expect(new OpenAIProvider(() => "api_key").buildBody({ ...research, maxSearches: undefined })).not.toHaveProperty("max_tool_calls");
    expect(new OpenAIProvider(() => "api_key").buildBody({ ...research, webSearch: false })).not.toHaveProperty("max_tool_calls");
  });

  it("OpenAI still requires a function call when function tools come with search", () => {
    const body = new OpenAIProvider(() => "chatgpt").buildBody({ ...answer, tools: [fn], webSearch: true });
    expect(body.tools).toEqual([{ type: "function", name: "pick", description: "Pick one.", parameters: fn.parameters, strict: true }, { type: "web_search" }]);
    expect(body).toMatchObject({ tool_choice: "required", parallel_tool_calls: false });
  });

  it("Claude offers the server search tool without a tool_choice", () => {
    const on = new AnthropicProvider().buildBody({ ...answer, webSearch: true });
    expect(on.tools).toEqual([{ type: "web_search_20260318", name: "web_search", max_uses: 5, allowed_callers: ["direct"] }]);
    expect(on).not.toHaveProperty("tool_choice");
    expect(on).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    const off = new AnthropicProvider().buildBody({ ...answer, webSearch: false });
    expect(off).toEqual(new AnthropicProvider().buildBody(answer));
    expect(off).not.toHaveProperty("tools");
  });

  it("Claude keeps client tools and their tool_choice beside the search tool", () => {
    const body = new AnthropicProvider().buildBody({ ...answer, tools: [fn], webSearch: true });
    expect(body.tools).toEqual([
      { name: "pick", description: "Pick one.", strict: true, input_schema: fn.parameters },
      { type: "web_search_20260318", name: "web_search", max_uses: 5, allowed_callers: ["direct"] },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("adds the web search rules to the answer prompt only when search is on", () => {
    const on = new AnthropicProvider().buildBody({ ...answer, webSearch: true });
    const off = new AnthropicProvider().buildBody(answer);
    const system = (body: Record<string, unknown>) => (body.system as { text: string }[])[0].text;
    const user = (body: Record<string, unknown>) => (body.messages as { content: string }[]).at(-1)!.content;
    expect(system(on)).toContain("You can search the web.");
    expect(user(on)).toContain("Never invent papers, authors or \\cite keys.");
    expect(system(off)).not.toContain("search the web");
    expect(user(off)).not.toContain("search the web");
  });
});
