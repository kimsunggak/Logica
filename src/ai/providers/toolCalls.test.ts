import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIRequest, ToolDefinition } from "../types";

// The adapters stream through the Rust transport; replay a recorded body instead.
let body = "";
let sent: Record<string, unknown> | null = null;
vi.mock("../streaming/transport", () => ({
  streamProviderRequest: async (options: { body: Record<string, unknown>; onChunk: (text: string) => void }) => {
    sent = options.body;
    // Uneven chunks, like the network.
    for (let i = 0; i < body.length; i += 37) options.onChunk(body.slice(i, i + 37));
  },
  cancelProviderRequest: async () => {},
  providerGet: async () => ({}),
}));

const { OpenAIProvider } = await import("./openai/openaiProvider");
const { AnthropicProvider } = await import("./anthropic/anthropicProvider");

const tool: ToolDefinition = {
  name: "answer_question",
  description: "Answer from the paper.",
  parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
};

const request: AIRequest = {
  id: "r1",
  task: "judge",
  instruction: "What does Table 2 show?",
  context: {},
  tools: [tool],
  model: "gpt-6.1-sol",
  reasoningEffort: "low",
};

const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

beforeEach(() => {
  body = "";
  sent = null;
});

describe("OpenAI tool calls", () => {
  it("offers tools as functions and sets the reasoning effort", () => {
    const out = new OpenAIProvider(() => "chatgpt").buildBody(request);
    expect(out.tools).toEqual([{ type: "function", name: "answer_question", description: "Answer from the paper.", parameters: tool.parameters, strict: true }]);
    expect(out).toMatchObject({ tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "low" }, store: false, stream: true });
  });

  it("leaves tools and reasoning out when the request has none", () => {
    const out = new OpenAIProvider(() => "chatgpt").buildBody({ ...request, tools: undefined, reasoningEffort: undefined });
    expect(out).not.toHaveProperty("tools");
    expect(out).not.toHaveProperty("tool_choice");
    expect(out).not.toHaveProperty("reasoning");
  });

  it("reads a streamed function call and the cached token count", async () => {
    body = sse([
      { type: "response.created" },
      { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_9", name: "answer_question", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"reason":"names ' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: 'Table 2"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"reason":"names Table 2"}' },
      { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_9", name: "answer_question", arguments: '{"reason":"names Table 2"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1536 }, output_tokens: 30 } } },
    ]);
    const response = await new OpenAIProvider(() => "chatgpt").generate(request);
    expect(sent?.tools).toBeTruthy();
    expect(response.text).toBe("");
    expect(response.toolCalls).toEqual([{ id: "call_9", name: "answer_question", arguments: { reason: "names Table 2" } }]);
    expect(response.usage).toEqual({ inputTokens: 2000, cachedInputTokens: 1536, outputTokens: 30 });
  });

  it("returns plain text without tool calls when the model replies directly", async () => {
    body = sse([
      { type: "response.output_text.delta", delta: "You're " },
      { type: "response.output_text.delta", delta: "welcome." },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } },
    ]);
    const response = await new OpenAIProvider(() => "chatgpt").generate(request);
    expect(response.text).toBe("You're welcome.");
    expect(response).not.toHaveProperty("toolCalls");
  });

  it("falls back to the function calls in the final response", async () => {
    body = sse([
      {
        type: "response.completed",
        response: { output: [{ id: "fc_2", type: "function_call", call_id: "call_2", name: "refine_question", arguments: "{}" }], usage: {} },
      },
    ]);
    const response = await new OpenAIProvider(() => "chatgpt").generate(request);
    expect(response.toolCalls).toEqual([{ id: "call_2", name: "refine_question", arguments: {} }]);
  });

  it("keeps a call whose arguments are not valid JSON", async () => {
    body = sse([
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_3", type: "function_call", call_id: "c3", name: "refine_question" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_3", delta: '{"reason": ' },
      { type: "response.completed", response: { usage: {} } },
    ]);
    const response = await new OpenAIProvider(() => "chatgpt").generate(request);
    expect(response.toolCalls).toEqual([{ id: "c3", name: "refine_question", arguments: {} }]);
  });
});

describe("Claude tool calls", () => {
  it("offers tools with an input schema and one call at a time", () => {
    const out = new AnthropicProvider().buildBody({ ...request, model: "claude-sonnet-5-5" });
    expect(out.tools).toEqual([{ name: "answer_question", description: "Answer from the paper.", input_schema: tool.parameters }]);
    expect(out.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(out).not.toHaveProperty("reasoning");
  });

  it("maps reasoning effort to adaptive thinking and leaves it out when unset", () => {
    const provider = new AnthropicProvider();
    expect(provider.buildBody({ ...request, model: "claude-sonnet-5-5", reasoningEffort: "high" })).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    const out = provider.buildBody({ ...request, reasoningEffort: undefined });
    expect(out).not.toHaveProperty("thinking");
    expect(out).not.toHaveProperty("output_config");
  });

  it("reads a streamed tool_use block", async () => {
    body = sse([
      { type: "message_start", message: { usage: { input_tokens: 1200, cache_read_input_tokens: 1024 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "refine_question", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"reason": "vague' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ' question"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]);
    const response = await new AnthropicProvider().generate({ ...request, model: "claude-sonnet-5-5" });
    expect(response.toolCalls).toEqual([{ id: "toolu_1", name: "refine_question", arguments: { reason: "vague question" } }]);
    expect(response.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 20 });
  });
});
