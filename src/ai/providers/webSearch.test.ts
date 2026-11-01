import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromHttpError } from "../errors";
import { t } from "../../i18n";
import type { AIRequest } from "../types";

// The adapters stream through the Rust transport; replay recorded bodies instead,
// one per request, and keep every request body sent.
let replies: (string | Error)[] = [];
let sent: Record<string, any>[] = [];
vi.mock("../streaming/transport", () => ({
  streamProviderRequest: async (options: { body: Record<string, unknown>; onChunk: (text: string) => void }) => {
    sent.push(structuredClone(options.body));
    const body = replies.shift() ?? "";
    if (body instanceof Error) throw body;
    for (let i = 0; i < body.length; i += 37) options.onChunk(body.slice(i, i + 37));
  },
  cancelProviderRequest: async () => {},
  providerGet: async () => ({}),
}));

const { AnthropicProvider, MAX_CONTINUATIONS, WEB_SEARCH_TOOL } = await import("./anthropic/anthropicProvider");
const { OpenAIProvider } = await import("./openai/openaiProvider");

const request: AIRequest = {
  id: "r1",
  task: "answer",
  instruction: "What is the latest work on occlusion-robust pose estimation?",
  context: {},
  model: "claude-sonnet-5-5",
  reasoningEffort: "medium",
  webSearch: true,
};

const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const delta = (index: number, d: Record<string, unknown>) => ({ type: "content_block_delta", index, delta: d });
const start = (index: number, block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block: block });
const stop = (index: number) => ({ type: "content_block_stop", index });
const end = (reason: string, usage: Record<string, unknown> = { output_tokens: 50 }) => [
  { type: "message_delta", delta: { stop_reason: reason }, usage },
  { type: "message_stop" },
];

const result1 = { type: "web_search_result", url: "https://example.org/a", title: "Paper A", page_age: "2 days ago", encrypted_content: "enc-a" };
const result2 = { type: "web_search_result", url: "https://example.org/b", title: "Paper B", page_age: null, encrypted_content: "enc-b" };
const citation = (url: string, title: string) => ({ type: "web_search_result_location", url, title, cited_text: "…", encrypted_index: `idx-${title}` });

/** Thinking, a note, a search with results, then the answer. */
function searchTurn(answer: Record<string, unknown>[], tail = end("end_turn", { output_tokens: 80, server_tool_use: { web_search_requests: 1 } })) {
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 800 } } },
    start(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "Need recent work." }),
    delta(0, { type: "signature_delta", signature: "sig-1" }),
    stop(0),
    start(1, { type: "text", text: "" }),
    delta(1, { type: "text_delta", text: "Let me search for that." }),
    stop(1),
    start(2, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
    delta(2, { type: "input_json_delta", partial_json: '{"query": "occlusion' }),
    delta(2, { type: "input_json_delta", partial_json: ' pose 2026"}' }),
    stop(2),
    start(3, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [result1, result2] }),
    stop(3),
    ...answer,
    ...tail,
  ]);
}

beforeEach(() => {
  replies = [];
  sent = [];
});

describe("Claude web search", () => {
  it("drops the note written before the search, signals the search and collects cited pages", async () => {
    replies = [searchTurn([
      start(4, { type: "text", text: "" }),
      delta(4, { type: "citations_delta", citation: citation("https://example.org/b", "Paper B") }),
      delta(4, { type: "text_delta", text: "Paper B is the latest." }),
      delta(4, { type: "citations_delta", citation: citation("https://example.org/b", "Paper B") }),
      stop(4),
    ])];
    const texts: string[] = [];
    const searches: (string | undefined)[] = [];
    const response = await new AnthropicProvider().generate(request, { onDelta: (_d, full) => texts.push(full), onSearch: (q) => searches.push(q) });
    expect(sent[0].tools).toEqual([WEB_SEARCH_TOOL]);
    expect(sent[0]).not.toHaveProperty("tool_choice");
    expect(searches).toEqual([undefined, "occlusion pose 2026"]);
    expect(texts).toEqual(["Let me search for that.", "Paper B is the latest."]);
    expect(response.text).toBe("Paper B is the latest.");
    // Cited pages win over the search results, one per URL.
    expect(response.sources).toEqual([{ url: "https://example.org/b", title: "Paper B" }]);
    expect(response.searchQueries).toEqual(["occlusion pose 2026"]);
    expect(response.usage).toEqual({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 80, webSearchRequests: 1 });
    expect(response.finishReason).toBe("stop");
  });

  it("lists the search results when the answer cites nothing", async () => {
    replies = [searchTurn([start(4, { type: "text", text: "" }), delta(4, { type: "text_delta", text: "Nothing definitive." }), stop(4)])];
    const response = await new AnthropicProvider().generate(request);
    expect(response.sources).toEqual([{ url: "https://example.org/a", title: "Paper A" }, { url: "https://example.org/b", title: "Paper B" }]);
  });

  it("keeps no sources from a failed search", async () => {
    replies = [sse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      start(0, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: '{"query":"x"}' }),
      stop(0),
      start(1, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }),
      stop(1),
      start(2, { type: "text", text: "" }),
      delta(2, { type: "text_delta", text: "The search failed; from the paper alone…" }),
      stop(2),
      ...end("end_turn"),
    ])];
    const response = await new AnthropicProvider().generate(request);
    expect(response.text).toBe("The search failed; from the paper alone…");
    expect(response).not.toHaveProperty("sources");
  });

  it("continues a paused turn with the blocks sent back unchanged and the same tools", async () => {
    replies = [
      searchTurn([], end("pause_turn", { output_tokens: 40, server_tool_use: { web_search_requests: 1 } })),
      sse([
        { type: "message_start", message: { usage: { input_tokens: 1500 } } },
        start(0, { type: "text", text: "" }),
        delta(0, { type: "citations_delta", citation: citation("https://example.org/a", "Paper A") }),
        delta(0, { type: "text_delta", text: "Paper A." }),
        stop(0),
        ...end("end_turn", { output_tokens: 20 }),
      ]),
    ];
    const searches: (string | undefined)[] = [];
    const response = await new AnthropicProvider().generate(request, { onSearch: (q) => searches.push(q) });
    expect(sent).toHaveLength(2);
    const [first, second] = sent;
    expect(second.tools).toEqual(first.tools);
    expect(second.messages.slice(0, -1)).toEqual(first.messages);
    expect(second.messages.at(-1)).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need recent work.", signature: "sig-1" },
        { type: "text", text: "Let me search for that." },
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "occlusion pose 2026" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [result1, result2] },
      ],
    });
    expect(searches).toEqual([undefined, "occlusion pose 2026"]);
    expect(response.text).toBe("Paper A.");
    expect(response.sources).toEqual([{ url: "https://example.org/a", title: "Paper A" }]);
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 2500, cachedInputTokens: 800, outputTokens: 60, webSearchRequests: 1 });
  });

  it("keeps cited text blocks in the content sent back after a second pause", async () => {
    const answered = sse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      start(0, { type: "text", text: "" }),
      delta(0, { type: "citations_delta", citation: citation("https://example.org/a", "Paper A") }),
      delta(0, { type: "text_delta", text: "Partly answered." }),
      stop(0),
      ...end("pause_turn"),
    ]);
    replies = [searchTurn([], end("pause_turn")), answered, sse([{ type: "message_start", message: { usage: {} } }, ...end("end_turn")])];
    await new AnthropicProvider().generate(request);
    const content = sent[2].messages.at(-1).content;
    expect(content).toHaveLength(5);
    expect(content[4]).toEqual({ type: "text", text: "Partly answered.", citations: [citation("https://example.org/a", "Paper A")] });
  });

  it("stops continuing after the limit and returns what came as cut off", async () => {
    const paused = sse([{ type: "message_start", message: { usage: {} } }, start(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Still looking." }), stop(0), ...end("pause_turn")]);
    replies = Array.from({ length: MAX_CONTINUATIONS + 2 }, () => paused);
    const response = await new AnthropicProvider().generate(request);
    expect(sent).toHaveLength(MAX_CONTINUATIONS + 1);
    expect(response.finishReason).toBe("length");
    expect(response.text).toBe("Still looking.".repeat(MAX_CONTINUATIONS + 1));
  });

  it("adds a hint to turn off web search when a search request is rejected", async () => {
    const rejected = fromHttpError("anthropic", 400, JSON.stringify({ error: { type: "invalid_request_error", message: "web search is disabled" } }));
    replies = [rejected];
    await expect(new AnthropicProvider().generate(request)).rejects.toThrow(t("ai.err.webSearch"));
    replies = [rejected];
    const plain = new AnthropicProvider().generate({ ...request, webSearch: false });
    await expect(plain).rejects.toThrow(rejected.message);
    await expect(plain).rejects.not.toThrow(t("ai.err.webSearch"));
  });
});

describe("OpenAI web search", () => {
  const openai = { ...request, model: "gpt-6.1-sol" };
  const call = { id: "ws_1", type: "web_search_call" };

  it("drops the note before the search, signals it and collects citations", async () => {
    replies = [sse([
      { type: "response.output_text.delta", item_id: "msg_0", delta: "Let me check." },
      { type: "response.output_item.added", output_index: 1, item: { ...call, status: "in_progress" } },
      { type: "response.web_search_call.in_progress", output_index: 1, item_id: "ws_1" },
      { type: "response.web_search_call.searching", output_index: 1, item_id: "ws_1" },
      { type: "response.web_search_call.completed", output_index: 1, item_id: "ws_1" },
      { type: "response.output_item.done", output_index: 1, item: { ...call, status: "completed", action: { type: "search", queries: ["pose 2026"] } } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "See Paper A." },
      { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.org/a", title: "Paper A", start_index: 4, end_index: 11 } },
      { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10 } } },
    ])];
    const texts: string[] = [];
    const searches: (string | undefined)[] = [];
    const response = await new OpenAIProvider(() => "chatgpt").generate(openai, { onDelta: (_d, full) => texts.push(full), onSearch: (q) => searches.push(q) });
    expect(sent[0].tools).toEqual([{ type: "web_search" }]);
    expect(sent[0]).not.toHaveProperty("tool_choice");
    expect(sent[0]).not.toHaveProperty("parallel_tool_calls");
    expect(searches).toEqual([undefined, "pose 2026"]);
    expect(texts).toEqual(["Let me check.", "See Paper A."]);
    expect(response.text).toBe("See Paper A.");
    expect(response.sources).toEqual([{ url: "https://example.org/a", title: "Paper A" }]);
    expect(response.searchQueries).toEqual(["pose 2026"]);
    expect(response.usage).toMatchObject({ webSearchRequests: 1 });
  });

  it("reads citations and searches missing from the stream in the final response", async () => {
    replies = [sse([
      { type: "response.output_text.delta", delta: "See both." },
      {
        type: "response.completed",
        response: {
          output: [
            { ...call, status: "completed", action: { type: "search", query: "pose" } },
            { id: "msg_1", type: "message", content: [{ type: "output_text", text: "See both.", annotations: [
              { type: "url_citation", url: "https://example.org/a", title: "Paper A" },
              { type: "url_citation", url: "https://example.org/b", title: "Paper B" },
              { type: "url_citation", url: "https://example.org/a", title: "Paper A" },
            ] }] },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
    ])];
    const searches: (string | undefined)[] = [];
    const response = await new OpenAIProvider(() => "chatgpt").generate(openai, { onSearch: (q) => searches.push(q) });
    // The answer has streamed already; a search found only now does not clear it.
    expect(searches).toEqual([]);
    expect(response.text).toBe("See both.");
    expect(response.sources).toEqual([{ url: "https://example.org/a", title: "Paper A" }, { url: "https://example.org/b", title: "Paper B" }]);
    expect(response.searchQueries).toEqual(["pose"]);
    expect(response.usage).toMatchObject({ webSearchRequests: 1 });
  });

  it("reads every query of a search, and the deprecated single query", async () => {
    replies = [sse([
      { type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: { ...call, status: "completed", action: { type: "search", queries: ["pose 2026", " occlusion benchmark "] } } },
      { type: "response.output_item.added", output_index: 1, item: { id: "ws_2", type: "web_search_call", status: "in_progress" } },
      { type: "response.output_item.done", output_index: 1, item: { id: "ws_2", type: "web_search_call", status: "completed", action: { type: "search", query: "OCHuman" } } },
      { type: "response.output_text.delta", delta: "Answer." },
      { type: "response.completed", response: { usage: {} } },
    ])];
    const searches: (string | undefined)[] = [];
    const response = await new OpenAIProvider(() => "chatgpt").generate(openai, { onSearch: (q) => searches.push(q) });
    expect(searches).toEqual([undefined, "pose 2026", "occlusion benchmark", undefined, "OCHuman"]);
    expect(response.searchQueries).toEqual(["pose 2026", "occlusion benchmark", "OCHuman"]);
    expect(response.usage).toMatchObject({ webSearchRequests: 2 });
  });

  it("adds a hint to turn off web search when a search request is rejected", async () => {
    replies = [fromHttpError("openai", 400, JSON.stringify({ error: { type: "invalid_request_error", message: "Tool 'web_search' is not supported" } }))];
    await expect(new OpenAIProvider(() => "chatgpt").generate(openai)).rejects.toThrow(t("ai.err.webSearch"));
  });
});
