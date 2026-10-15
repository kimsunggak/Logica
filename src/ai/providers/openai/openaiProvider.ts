/**
 * OpenAI adapter (Responses API, streaming).
 *
 * Two official authentication methods, both attached by the backend:
 * - Sign in with ChatGPT: OAuth access token, usage draws on the user's
 *   ChatGPT plan (src-tauri/src/chatgpt.rs).
 * - API key: OpenAI Platform key from the OS credential store.
 * The request format is identical; only the credential differs.
 */
import { getChatGPTStatus, getCredentialStatus } from "../../credentials/credentialStore";
import { AIError, fromStreamError } from "../../errors";
import { isOpenAITextModel } from "../../models/modelConfig";
import { t } from "../../../i18n";
import { buildPrompt } from "../../prompts";
import { SSEParser, type SSEEvent } from "../../streaming/sse";
import { cancelProviderRequest, providerGet, streamProviderRequest } from "../../streaming/transport";
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  AIUsage,
  AuthMethodKind,
  FinishReason,
  ModelConfig,
  StreamHandlers,
} from "../../types";
import { toToolCalls, type StreamedCall } from "../toolCalls";

/** Platform API keys get `data[]`; ChatGPT sign-in gets the plan catalog `models[]`. */
interface OpenAIModelList {
  data?: { id: string; created?: number }[];
  models?: { slug?: string; display_name?: string; visibility?: string }[];
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export class OpenAIProvider implements AIProvider {
  readonly id = "openai" as const;
  readonly name = "OpenAI";
  readonly authMethods = [
    { kind: "chatgpt" as const, label: "Sign in with ChatGPT", helpUrl: CHATGPT_USAGE_URL },
    { kind: "api_key" as const, label: "API key", helpUrl: "https://platform.openai.com/api-keys", placeholder: "sk-..." },
  ];

  /** @param authMethod returns the authentication method chosen in Settings. */
  constructor(private readonly authMethod: () => AuthMethodKind) {}

  async isAuthenticated(): Promise<boolean> {
    if (this.authMethod() === "chatgpt") {
      const status = await getChatGPTStatus();
      return status.connected && status.planUsage;
    }
    return (await getCredentialStatus(this.id)).stored;
  }

  /** Explain errors in terms of the active sign-in method. */
  private explain(error: AIError, auth: AuthMethodKind): AIError {
    if (auth !== "chatgpt") return error;
    const opts = { provider: this.id, status: error.status };
    if (error.kind === "auth") {
      return new AIError("auth", error.status ? t("ai.err.chatgptRejected") : error.message, opts);
    }
    if (error.kind === "rate_limit" || error.kind === "quota") {
      return new AIError(error.kind, t("ai.err.chatgptLimit", { url: CHATGPT_USAGE_URL }), opts);
    }
    if (error.kind === "model_unavailable") {
      return new AIError("model_unavailable", t("ai.err.chatgptModel"), opts);
    }
    return error;
  }

  /**
   * Convert the shared prompt payload into a Responses API request body.
   * ChatGPT plan usage rejects `max_output_tokens`, so it is sent only with an API key.
   */
  buildBody(request: AIRequest, auth: AuthMethodKind = this.authMethod()): Record<string, unknown> {
    const prompt = buildPrompt(request);
    return {
      model: request.model,
      instructions: prompt.system,
      input: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      store: false,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: true,
            })),
            tool_choice: "auto",
            parallel_tool_calls: false,
          }
        : {}),
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
      ...(request.maxOutputTokens && auth === "api_key" ? { max_output_tokens: request.maxOutputTokens } : {}),
    };
  }

  async generate(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    const auth = this.authMethod();
    try {
      return await this.stream(request, auth, handlers);
    } catch (err) {
      throw err instanceof AIError ? this.explain(err, auth) : err;
    }
  }

  private async stream(request: AIRequest, auth: AuthMethodKind, handlers?: StreamHandlers): Promise<AIResponse> {
    const parser = new SSEParser();
    let text = "";
    let finishReason: FinishReason = "stop";
    let usage: AIUsage | undefined;
    let completed = false;
    let streamError: AIError | null = null;
    // Function calls by output item; arguments arrive as streamed JSON text.
    const calls = new Map<string, StreamedCall>();
    const callOf = (key: string) => {
      let call = calls.get(key);
      if (!call) calls.set(key, (call = { id: "", name: "", args: "" }));
      return call;
    };
    const keyOf = (json: any): string => String(json.item_id ?? json.item?.id ?? `#${json.output_index}`);
    const readItem = (json: any, item: any) => {
      if (item?.type !== "function_call") return;
      const call = callOf(keyOf(json));
      if (typeof item.call_id === "string") call.id = item.call_id;
      if (typeof item.name === "string") call.name = item.name;
      if (typeof item.arguments === "string" && item.arguments) call.args = item.arguments;
    };

    const handle = (event: SSEEvent) => {
      if (event.data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(event.data);
      } catch {
        streamError ??= new AIError("malformed_response", t("ai.err.malformed"), { provider: this.id });
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
        case "response.output_item.added":
        case "response.output_item.done":
          readItem(json, json.item);
          break;
        case "response.function_call_arguments.delta":
          if (typeof json.delta === "string") callOf(keyOf(json)).args += json.delta;
          break;
        case "response.function_call_arguments.done":
          if (typeof json.arguments === "string") callOf(keyOf(json)).args = json.arguments;
          break;
        case "response.completed":
          completed = true;
          usage = {
            inputTokens: json.response?.usage?.input_tokens,
            cachedInputTokens: json.response?.usage?.input_tokens_details?.cached_tokens,
            outputTokens: json.response?.usage?.output_tokens,
          };
          // Calls not streamed as items (some backends) are still in the final output.
          if (calls.size === 0 && Array.isArray(json.response?.output)) {
            json.response.output.forEach((item: any, i: number) => readItem({ item_id: item?.id ?? `out${i}` }, item));
          }
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
      body: this.buildBody(request, auth),
      auth,
      onChunk: (chunk) => parser.push(chunk).forEach(handle),
    });
    parser.end().forEach(handle);

    if (streamError) throw streamError;
    if (!completed) {
      throw new AIError("stream_interrupted", t("ai.err.incomplete", { provider: "OpenAI" }), {
        provider: this.id,
      });
    }
    const toolCalls = toToolCalls([...calls.values()]);
    return { id: request.id, provider: this.id, model: request.model, text, ...(toolCalls.length ? { toolCalls } : {}), finishReason, usage };
  }

  async cancel(requestId: string): Promise<void> {
    await cancelProviderRequest(requestId);
  }

  async listModels(): Promise<ModelConfig[]> {
    const auth = this.authMethod();
    let list: OpenAIModelList;
    try {
      list = await providerGet<OpenAIModelList>(this.id, "/v1/models", auth);
    } catch (err) {
      throw err instanceof AIError ? this.explain(err, auth) : err;
    }
    if (Array.isArray(list.models)) {
      return list.models
        .filter((m) => m.visibility === "list" && typeof m.slug === "string" && m.slug.trim())
        .map((m) => ({
          id: m.slug!,
          provider: this.id,
          displayName: m.display_name?.trim() || m.slug!,
          supportsStreaming: true,
          source: "api" as const,
        }));
    }
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
