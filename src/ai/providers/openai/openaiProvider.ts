/**
 * OpenAI adapter (Responses API, streaming).
 *
 * Authentication: an OpenAI API key, stored in the OS credential store and
 * attached by the backend. See README "AI providers" for why API keys are
 * the method used here.
 */
import { getCredentialStatus } from "../../credentials/credentialStore";
import { AIError, fromStreamError } from "../../errors";
import { isOpenAITextModel } from "../../models/modelConfig";
import { buildPrompt } from "../../prompts";
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

interface OpenAIModelList {
  data?: { id: string; created?: number }[];
}

export class OpenAIProvider implements AIProvider {
  readonly id = "openai" as const;
  readonly name = "OpenAI";
  readonly authMethods = [
    {
      kind: "api_key" as const,
      label: "API key",
      helpUrl: "https://platform.openai.com/api-keys",
      placeholder: "sk-...",
    },
  ];

  async isAuthenticated(): Promise<boolean> {
    return (await getCredentialStatus(this.id)).stored;
  }

  /** Convert the shared prompt payload into a Responses API request body. */
  buildBody(request: AIRequest): Record<string, unknown> {
    const prompt = buildPrompt(request);
    return {
      model: request.model,
      instructions: prompt.system,
      input: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      store: false,
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    };
  }

  async generate(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    const parser = new SSEParser();
    let text = "";
    let finishReason: FinishReason = "stop";
    let usage: AIUsage | undefined;
    let completed = false;
    let streamError: AIError | null = null;

    const handle = (event: SSEEvent) => {
      if (event.data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(event.data);
      } catch {
        streamError ??= new AIError("malformed_response", "OpenAI sent a malformed stream event.", { provider: this.id });
        return;
      }
      switch (json?.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          if (typeof json.delta === "string") {
            text += json.delta;
            handlers?.onDelta?.(json.delta, text);
          }
          break;
        case "response.completed":
          completed = true;
          usage = {
            inputTokens: json.response?.usage?.input_tokens,
            outputTokens: json.response?.usage?.output_tokens,
          };
          break;
        case "response.incomplete":
          completed = true;
          finishReason = "length";
          break;
        case "response.failed":
          streamError = fromStreamError(this.id, json.response?.error ?? { message: "Response failed" });
          break;
        case "error":
          streamError = fromStreamError(this.id, { type: json.code ?? json.type, code: json.code, message: json.message });
          break;
      }
    };

    await streamProviderRequest({
      requestId: request.id,
      provider: this.id,
      path: "/v1/responses",
      body: this.buildBody(request),
      onChunk: (chunk) => parser.push(chunk).forEach(handle),
    });
    parser.end().forEach(handle);

    if (streamError) throw streamError;
    if (!completed) {
      throw new AIError("stream_interrupted", "The OpenAI stream ended before the response was complete.", {
        provider: this.id,
      });
    }
    return { id: request.id, provider: this.id, model: request.model, text, finishReason, usage };
  }

  async cancel(requestId: string): Promise<void> {
    await cancelProviderRequest(requestId);
  }

  async listModels(): Promise<ModelConfig[]> {
    const list = await providerGet<OpenAIModelList>(this.id, "/v1/models");
    return (list.data ?? [])
      .filter((m) => typeof m.id === "string" && isOpenAITextModel(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({
        id: m.id,
        provider: this.id,
        displayName: m.id,
        supportsStreaming: true,
        source: "api" as const,
      }));
  }
}
