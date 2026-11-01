/**
 * Claude adapter (Anthropic Messages API, streaming).
 *
 * Authentication: an Anthropic API key, stored in the OS credential store and
 * attached by the backend (`x-api-key`). Consumer Claude.ai logins are not
 * used: Anthropic does not offer them to third-party applications.
 */
import { getCredentialStatus } from "../../credentials/credentialStore";
import { AIError, fromStreamError } from "../../errors";
import { buildPrompt } from "../../prompts";
import { t } from "../../../i18n";
import { SSEParser, type SSEEvent } from "../../streaming/sse";
import { cancelProviderRequest, providerGet, streamProviderRequest } from "../../streaming/transport";
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  AIUsage,
  FinishReason,
  ModelConfig,
  StreamHandlers,
  TextCitation,
} from "../../types";
import { toToolCalls, type StreamedCall } from "../toolCalls";
import { SourceList, withSearchHint } from "../webSearch";

interface AnthropicModelList {
  data?: { id: string; display_name?: string; created_at?: string }[];
}

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Claude's server-side web search. `allowed_callers: ["direct"]` turns off
 * dynamic filtering, so no code execution blocks join the stream; `max_uses`
 * limits the cost and wait of one answer.
 */
export const WEB_SEARCH_TOOL = { type: "web_search_20260318", name: "web_search", max_uses: 5, allowed_callers: ["direct"] };

/** Continuations of a paused server-side search loop, after the first request. */
export const MAX_CONTINUATIONS = 3;

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic" as const;
  readonly name = "Claude";
  readonly authMethods = [
    {
      kind: "api_key" as const,
      label: "API key",
      helpUrl: "https://platform.claude.com/settings/keys",
      placeholder: "sk-ant-...",
    },
  ];

  async isAuthenticated(): Promise<boolean> {
    return (await getCredentialStatus(this.id)).stored;
  }

  /** Convert the shared prompt payload into a Messages API request body. */
  buildBody(request: AIRequest): Record<string, unknown> {
    const prompt = buildPrompt(request);
    const tools: Record<string, unknown>[] = [
      // strict: inputs are sampled to match the schema.
      ...(request.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, strict: true, input_schema: tool.parameters })),
      ...(request.webSearch ? [WEB_SEARCH_TOOL] : []),
    ];
    return {
      model: request.model,
      // Cache the tools and the system prompt, which every call of a task repeats;
      // the messages after them change from turn to turn.
      system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
      messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(request.reasoningEffort
        ? { thinking: { type: "adaptive" }, output_config: { effort: request.reasoningEffort } }
        : {}),
      ...(tools.length ? { tools } : {}),
      ...(request.tools?.length
        ? {
            // Current Claude models reject a forced tool_choice ("any"/"tool") with a 400.
            // The prompts ask for exactly one call; strict schemas keep its input valid.
            tool_choice: { type: "auto", disable_parallel_tool_use: true },
          }
        : {}),
    };
  }

  async generate(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    try {
      return await this.run(request, handlers);
    } catch (err) {
      throw request.webSearch ? withSearchHint(err) : err;
    }
  }

  /**
   * Stream the response. When the server-side search loop pauses
   * (`pause_turn`), the content so far goes back unchanged as the assistant
   * turn and the same request continues it, at most `MAX_CONTINUATIONS` times.
   */
  private async run(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    const body = this.buildBody(request);
    const baseMessages = body.messages as unknown[];
    let text = "";
    let finishReason: FinishReason = "stop";
    const usage: AIUsage = {};
    let refused = false;
    // Every content block of the turn, as the API sent it, across continuations.
    const blocks: any[] = [];
    // tool_use blocks by their place in `blocks`; input arrives as streamed JSON text.
    const calls = new Map<number, StreamedCall>();
    const cited = new SourceList();
    const found = new SourceList();
    const queries: string[] = [];
    // Where each text block starts in `text`; its citations cover the block.
    const textStart = new Map<number, number>();
    const spans: TextCitation[] = [];

    for (let pass = 0; ; pass++) {
      const parser = new SSEParser();
      // A continuation numbers its blocks from 0 again; they follow the earlier ones.
      const offset = blocks.length;
      // Streamed input of tool_use and server_tool_use blocks, parsed when the block ends.
      const inputs = new Map<number, string>();
      let completed = false;
      let stopReason: string | undefined;
      let streamError: AIError | null = null;
      const passUsage: AIUsage = {};

      const handle = (event: SSEEvent) => {
        let json: any;
        try {
          json = JSON.parse(event.data);
        } catch {
          streamError ??= new AIError("malformed_response", t("ai.err.malformed"), { provider: this.id });
          return;
        }
        const at = typeof json?.index === "number" ? offset + json.index : -1;
        const block = blocks[at];
        switch (json?.type) {
          case "message_start":
            passUsage.inputTokens = json.message?.usage?.input_tokens;
            passUsage.cachedInputTokens = json.message?.usage?.cache_read_input_tokens;
            break;
          case "content_block_start": {
            const started = json.content_block;
            if (at < 0 || !started || typeof started !== "object") break;
            blocks[at] = structuredClone(started);
            if (started.type === "text") {
              textStart.set(at, text.length);
            } else if (started.type === "tool_use") {
              calls.set(at, { id: started.id ?? "", name: started.name ?? "", args: "" });
              inputs.set(at, "");
            } else if (started.type === "server_tool_use") {
              inputs.set(at, "");
              if (started.name === "web_search") {
                // A note written before the search ("let me look that up") is not the answer,
                // unless the caller keeps it (research findings come between searches).
                if (!request.keepTextBeforeSearch) {
                  text = "";
                  spans.length = 0;
                }
                handlers?.onSearch?.();
              }
            } else if (started.type === "web_search_tool_result" && Array.isArray(started.content)) {
              for (const result of started.content) if (result?.type === "web_search_result") found.add(result.url, result.title);
            }
            break;
          }
          case "content_block_delta": {
            const delta = json.delta;
            if (!block || !delta) break;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              block.text = (block.text ?? "") + delta.text;
              text += delta.text;
              handlers?.onDelta?.(delta.text, text);
            } else if (delta.type === "citations_delta" && delta.citation) {
              (block.citations ??= []).push(delta.citation);
              cited.add(delta.citation.url, delta.citation.title);
            } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
              block.thinking = (block.thinking ?? "") + delta.thinking;
            } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
              block.signature = (block.signature ?? "") + delta.signature;
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && inputs.has(at)) {
              inputs.set(at, inputs.get(at)! + delta.partial_json);
              const call = calls.get(at);
              if (call) call.args += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            if (block?.type === "text" && Array.isArray(block.citations) && textStart.has(at)) {
              const start = Math.min(textStart.get(at)!, text.length);
              for (const c of block.citations) {
                if (typeof c?.url !== "string") continue;
                spans.push({
                  start,
                  end: text.length,
                  url: c.url,
                  ...(typeof c.title === "string" && c.title ? { title: c.title } : {}),
                  ...(typeof c.cited_text === "string" && c.cited_text.trim() ? { quote: c.cited_text.trim() } : {}),
                });
              }
            }
            const raw = inputs.get(at);
            if (!block || raw === undefined) break;
            if (raw.trim()) {
              try {
                block.input = JSON.parse(raw);
              } catch {
                // Kept as sent; a tool call reports invalid arguments through toToolCalls.
              }
            }
            if (block.type === "server_tool_use" && block.name === "web_search" && typeof block.input?.query === "string" && block.input.query.trim()) {
              queries.push(block.input.query.trim());
              handlers?.onSearch?.(block.input.query.trim());
            }
            break;
          }
          case "message_delta":
            if (typeof json.delta?.stop_reason === "string") stopReason = json.delta.stop_reason;
            if (json.usage?.output_tokens !== undefined) passUsage.outputTokens = json.usage.output_tokens;
            if (typeof json.usage?.server_tool_use?.web_search_requests === "number") passUsage.webSearchRequests = json.usage.server_tool_use.web_search_requests;
            break;
          case "message_stop":
            completed = true;
            break;
          case "error":
            streamError = fromStreamError(this.id, json.error ?? { message: "Stream error" });
            break;
          // ping and unknown events are ignored.
        }
      };

      const messages = pass === 0 ? baseMessages : [...baseMessages, { role: "assistant", content: structuredClone(blocks.filter(Boolean)) }];
      await streamProviderRequest({
        requestId: request.id,
        provider: this.id,
        path: "/v1/messages",
        body: { ...body, messages },
        onChunk: (chunk) => parser.push(chunk).forEach(handle),
      });
      parser.end().forEach(handle);

      if (streamError) throw streamError;
      if (!completed) {
        throw new AIError("stream_interrupted", t("ai.err.incomplete", { provider: "Claude" }), {
          provider: this.id,
        });
      }
      for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "webSearchRequests"] as const) {
        if (passUsage[key] !== undefined) usage[key] = (usage[key] ?? 0) + passUsage[key]!;
      }
      if (stopReason === "max_tokens") finishReason = "length";
      if (stopReason === "refusal") refused = true;
      if (stopReason !== "pause_turn") break;
      if (pass >= MAX_CONTINUATIONS) {
        // Still searching after every continuation: what came so far is cut off.
        finishReason = "length";
        break;
      }
    }

    const toolCalls = toToolCalls([...calls.values()]);
    if (refused && !text.trim() && !toolCalls.length) {
      throw new AIError("bad_request", t("ai.err.refused", { provider: "Claude" }), { provider: this.id });
    }
    const sources = cited.size ? cited.list() : found.list();
    return {
      id: request.id,
      provider: this.id,
      model: request.model,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      finishReason,
      usage,
      ...(sources.length ? { sources } : {}),
      ...(queries.length ? { searchQueries: queries } : {}),
      ...(spans.length ? { citations: spans } : {}),
    };
  }

  async cancel(requestId: string): Promise<void> {
    await cancelProviderRequest(requestId);
  }

  async listModels(): Promise<ModelConfig[]> {
    const list = await providerGet<AnthropicModelList>(this.id, "/v1/models");
    return (list.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        provider: this.id,
        displayName: m.display_name || m.id,
        supportsStreaming: true,
        source: "api" as const,
      }));
  }
}
