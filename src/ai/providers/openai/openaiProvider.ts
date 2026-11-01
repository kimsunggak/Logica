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
  TextCitation,
} from "../../types";
import { toToolCalls, type StreamedCall } from "../toolCalls";
import { SourceList, withSearchHint } from "../webSearch";

/** Platform API keys get `data[]`; ChatGPT sign-in gets the plan catalog `models[]`. */
interface OpenAIModelList {
  data?: { id: string; created?: number }[];
  models?: { slug?: string; display_name?: string; visibility?: string }[];
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** The queries of a finished `web_search_call` item: `action.queries`, or the deprecated `action.query`. */
function searchQueries(action: any): string[] {
  const all: unknown[] = Array.isArray(action?.queries) ? action.queries : [action?.query];
  return all.filter((q): q is string => typeof q === "string" && !!q.trim()).map((q) => q.trim());
}

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
   * The search limit (`max_tool_calls`) is sent only with an API key too: whether
   * ChatGPT plan usage accepts it is not known.
   */
  buildBody(request: AIRequest, auth: AuthMethodKind = this.authMethod()): Record<string, unknown> {
    const prompt = buildPrompt(request);
    return {
      model: request.model,
      instructions: prompt.system,
      input: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      store: false,
      ...(request.tools?.length || request.webSearch
        ? {
            tools: [
              ...(request.tools ?? []).map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: true,
              })),
              ...(request.webSearch ? [{ type: "web_search" }] : []),
            ],
          }
        : {}),
      // A call is required only of function tools; whether to search is the model's choice.
      ...(request.tools?.length ? { tool_choice: "required", parallel_tool_calls: false } : {}),
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
      ...(request.maxOutputTokens && auth === "api_key" ? { max_output_tokens: request.maxOutputTokens } : {}),
      // Caps every built-in tool call of the response; web search is the only one offered.
      ...(request.webSearch && request.maxSearches && auth === "api_key" ? { max_tool_calls: request.maxSearches } : {}),
    };
  }

  async generate(request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    const auth = this.authMethod();
    try {
      return await this.stream(request, auth, handlers);
    } catch (err) {
      const explained = err instanceof AIError ? this.explain(err, auth) : err;
      throw request.webSearch ? withSearchHint(explained) : explained;
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
    // Web searches by output item, and the pages the answer cites.
    const searches = new Set<string>();
    const queries: string[] = [];
    const sources = new SourceList();
    // Where each text part (output item and content index) starts in `text`; citation indexes count from there.
    const partStart = new Map<string, number>();
    const partKey = (itemId: unknown, contentIndex: unknown) => `${itemId ?? ""}:${typeof contentIndex === "number" ? contentIndex : 0}`;
    const spans: TextCitation[] = [];
    const spanKeys = new Set<string>();
    const startSearch = (key: string) => {
      if (searches.has(key)) return;
      searches.add(key);
      // A note written before the search ("let me look that up") is not the answer.
      text = "";
      partStart.clear();
      spans.length = 0;
      spanKeys.clear();
      handlers?.onSearch?.();
    };
    const searchDone = (key: string, item: any) => {
      startSearch(key);
      for (const query of searchQueries(item?.action)) {
        if (queries.includes(query)) continue;
        queries.push(query);
        handlers?.onSearch?.(query);
      }
    };
    const readCitations = (annotations: unknown, part: string) => {
      if (!Array.isArray(annotations)) return;
      for (const a of annotations) {
        if (a?.type !== "url_citation") continue;
        sources.add(a.url, a.title);
        const base = partStart.get(part);
        if (base === undefined || typeof a.url !== "string" || typeof a.start_index !== "number" || typeof a.end_index !== "number") continue;
        const span = { start: base + a.start_index, end: base + a.end_index, url: a.url, ...(typeof a.title === "string" && a.title ? { title: a.title } : {}) };
        const key = `${span.start}:${span.end}:${span.url}`;
        if (spanKeys.has(key)) continue;
        spanKeys.add(key);
        spans.push(span);
      }
    };
    const readItem = (json: any, item: any) => {
      if (item?.type === "web_search_call") {
        if (json.type === "response.output_item.added") startSearch(keyOf(json));
        else if (json.type === "response.output_item.done") searchDone(keyOf(json), item);
        else {
          // Only counted from the final output: the answer after it has already streamed.
          searches.add(keyOf(json));
          for (const query of searchQueries(item.action)) if (!queries.includes(query)) queries.push(query);
        }
        return;
      }
      if (item?.type === "message" && Array.isArray(item.content)) {
        item.content.forEach((part: any, i: number) => readCitations(part?.annotations, partKey(item.id ?? json.item_id, i)));
        return;
      }
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
            const part = partKey(json.item_id, json.content_index);
            if (!partStart.has(part)) partStart.set(part, text.length);
            text += json.delta;
            handlers?.onDelta?.(json.delta, text);
          }
          break;
        case "response.output_item.added":
        case "response.output_item.done":
          readItem(json, json.item);
          break;
        case "response.web_search_call.in_progress":
        case "response.web_search_call.searching":
        case "response.web_search_call.completed":
          if (json.item_id !== undefined) startSearch(String(json.item_id));
          break;
        case "response.output_text.annotation.added":
          readCitations([json.annotation], partKey(json.item_id, json.content_index));
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
          if (Array.isArray(json.response?.output)) {
            const output: any[] = json.response.output;
            // Calls not streamed as items (some backends) are still in the final output.
            if (calls.size === 0) output.forEach((item, i) => item?.type === "function_call" && readItem({ item_id: item?.id ?? `out${i}` }, item));
            // Citations can be missing from the stream; the final message has them all.
            output.forEach((item, i) => item?.type !== "function_call" && readItem({ type: json.type, item_id: item?.id ?? `out${i}` }, item));
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
    if (searches.size) usage = { ...usage, webSearchRequests: searches.size };
    return {
      id: request.id,
      provider: this.id,
      model: request.model,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      finishReason,
      usage,
      ...(sources.size ? { sources: sources.list() } : {}),
      ...(queries.length ? { searchQueries: queries } : {}),
      ...(spans.length ? { citations: spans } : {}),
    };
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
