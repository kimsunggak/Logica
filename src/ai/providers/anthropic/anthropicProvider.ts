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
} from "../../types";
import { toToolCalls, type StreamedCall } from "../toolCalls";

interface AnthropicModelList {
  data?: { id: string; display_name?: string; created_at?: string }[];
}

const DEFAULT_MAX_TOKENS = 8192;

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
    return {
      model: request.model,
      system: prompt.system,
      messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(request.reasoningEffort
        ? { thinking: { type: "adaptive" }, output_config: { effort: request.reasoningEffort } }
        : {}),
      ...(request.tools?.length
        ? {
            // strict: inputs are sampled to match the schema.
            tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, strict: true, input_schema: tool.parameters })),
            // Thinking only allows "auto"; without it a tool call is required.
            tool_choice: { type: request.reasoningEffort ? "auto" : "any", disable_parallel_tool_use: true },
          }
        : {}),
    };
  }

  async generate(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    const parser = new SSEParser();
    let text = "";
    let finishReason: FinishReason = "stop";
    const usage: AIUsage = {};
    let completed = false;
    let refused = false;
    let streamError: AIError | null = null;
    // tool_use blocks by content block index; input arrives as streamed JSON text.
    const calls = new Map<number, StreamedCall>();

    const handle = (event: SSEEvent) => {
      let json: any;
      try {
        json = JSON.parse(event.data);
      } catch {
        streamError ??= new AIError("malformed_response", t("ai.err.malformed"), { provider: this.id });
        return;
      }
      switch (json?.type) {
        case "message_start":
          usage.inputTokens = json.message?.usage?.input_tokens;
          usage.cachedInputTokens = json.message?.usage?.cache_read_input_tokens;
          break;
        case "content_block_start":
          if (json.content_block?.type === "tool_use") {
            calls.set(json.index, { id: json.content_block.id ?? "", name: json.content_block.name ?? "", args: "" });
          }
          break;
        case "content_block_delta":
          if (json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
            text += json.delta.text;
            handlers?.onDelta?.(json.delta.text, text);
          } else if (json.delta?.type === "input_json_delta" && typeof json.delta.partial_json === "string") {
            const call = calls.get(json.index);
            if (call) call.args += json.delta.partial_json;
          }
          break;
        case "message_delta":
          if (json.delta?.stop_reason === "max_tokens") finishReason = "length";
          if (json.delta?.stop_reason === "refusal") refused = true;
          if (json.usage?.output_tokens !== undefined) usage.outputTokens = json.usage.output_tokens;
          break;
        case "message_stop":
          completed = true;
          break;
        case "error":
          streamError = fromStreamError(this.id, json.error ?? { message: "Stream error" });
          break;
        // ping, content_block_stop and unknown events are ignored.
      }
    };

    await streamProviderRequest({
      requestId: request.id,
      provider: this.id,
      path: "/v1/messages",
      body: this.buildBody(request),
      onChunk: (chunk) => parser.push(chunk).forEach(handle),
    });
    parser.end().forEach(handle);

    if (streamError) throw streamError;
    const toolCalls = toToolCalls([...calls.values()]);
    if (refused && !text.trim() && !toolCalls.length) {
      throw new AIError("bad_request", t("ai.err.refused", { provider: "Claude" }), { provider: this.id });
    }
    if (!completed) {
      throw new AIError("stream_interrupted", t("ai.err.incomplete", { provider: "Claude" }), {
        provider: this.id,
      });
    }
    return { id: request.id, provider: this.id, model: request.model, text, ...(toolCalls.length ? { toolCalls } : {}), finishReason, usage };
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
