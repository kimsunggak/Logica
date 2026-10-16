/**
 * LLM Gateway: every model call of a chat turn goes through here.
 *
 *   Chat Orchestrator, Refine Module, Answer Module → callModel → aiService → Rust
 *
 * It picks the model for the call's task (`CHAT_MODELS`) and, when the primary
 * call fails before any text reached the screen, sends the same request to
 * the fallback provider. Each attempt is reported to the runtime debugger.
 */
import { AIError, toAIError } from "./errors";
import { CHAT_MODELS, MAX_OUTPUT_TOKENS, type ModelChoice } from "./models/modelConfig";
import { buildPrompt } from "./prompts";
import { aiService } from "./service";
import type { AIRequest, AIResponse, ChatTask } from "./types";
import { endSpan, failSpan, spanData, startSpan, step, type Span } from "../debug/trace";
import { t } from "../i18n";

/** Lets the caller stop a running chat turn. */
export interface RunControl {
  stopped: boolean;
  /** Provider request running now, for cancellation. */
  activeRequest: string | null;
}

export interface GatewayOptions {
  control: RunControl;
  /** Report the attempts under this span. */
  trace?: { traceId: string; parent: Span };
  /** Streamed text so far. Once text has been shown, a failure is not retried with the fallback provider. */
  onText?: (full: string) => void;
  /** Called before each attempt with the model it uses. */
  onAttempt?: (choice: ModelChoice, fallback: boolean) => void;
}

export interface GatewayResult {
  response: AIResponse;
  /** The model that produced `response`. */
  choice: ModelChoice;
  /** Set when the fallback answered because the primary call failed. */
  fallbackFrom?: { choice: ModelChoice; error: AIError };
}

/** What the caller decides; the gateway adds the task, model and limits. */
export type ChatRequest = Omit<AIRequest, "task" | "model" | "reasoningEffort" | "maxOutputTokens">;

/** The exact system prompt and messages a provider receives, for the debugger. */
export function promptText(request: AIRequest): string {
  const payload = buildPrompt(request);
  return [`[system]\n${payload.system}`, ...payload.messages.map((m) => `[${m.role}]\n${m.content}`)].join("\n\n");
}

async function canUse(choice: ModelChoice): Promise<boolean> {
  try {
    return await aiService.isAuthenticated(choice.provider);
  } catch {
    return false;
  }
}

function cancelledError(choice: ModelChoice): AIError {
  return new AIError("cancelled", t("chat.stopped"), { provider: choice.provider });
}

/** One provider request, reported as an `aiService.generate` span. */
async function attempt(
  task: ChatTask,
  request: AIRequest,
  choice: ModelChoice,
  fallback: boolean,
  options: GatewayOptions,
  onText: (full: string) => void,
): Promise<AIResponse> {
  options.onAttempt?.(choice, fallback);
  options.control.activeRequest = request.id;
  const span = options.trace
    ? startSpan(
        options.trace.traceId,
        options.trace.parent,
        "llm",
        "aiService.generate",
        () => ({
          task,
          provider: choice.provider,
          model: choice.model,
          reasoning_effort: choice.reasoningEffort ?? null,
          fallback,
          request_id: request.id,
          tools: request.tools?.map((tool) => tool.name) ?? [],
          prompt: promptText(request),
        }),
        request.id,
      )
    : null;
  let first = true;
  const started = performance.now();
  try {
    const response = await aiService.generate(choice.provider, request, {
      onDelta: (_delta, full) => {
        if (first && span) spanData(span, "llm", "first_text", () => ({ ms: Math.round(performance.now() - started) }));
        first = false;
        onText(full);
      },
    });
    if (span) {
      endSpan(span, "llm", () => ({
        text: response.text,
        tool_calls: response.toolCalls ?? [],
        finishReason: response.finishReason,
        usage: response.usage,
      }));
    }
    return response;
  } catch (err) {
    if (span) failSpan(span, "llm", err);
    throw err;
  } finally {
    options.control.activeRequest = null;
    if (options.control.stopped) throw cancelledError(choice);
  }
}

/**
 * Call the model for `task`. The fallback takes over when the primary call fails,
 * unless the user stopped the turn or part of the answer is already shown.
 */
export async function callModel(task: ChatTask, request: ChatRequest, options: GatewayOptions): Promise<GatewayResult> {
  const { primary, fallback } = CHAT_MODELS[task];
  // Stopped between two calls of the turn: do not start the next one.
  if (options.control.stopped) throw cancelledError(primary);
  let shown = false;
  const onText = (full: string) => {
    if (full) shown = true;
    options.onText?.(full);
  };
  const full = (choice: ModelChoice, id: string): AIRequest => ({
    ...request,
    id,
    task,
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    maxOutputTokens: MAX_OUTPUT_TOKENS[task],
  });
  const report = (fn: string, input: unknown, output: unknown) => {
    if (options.trace) step(options.trace.traceId, options.trace.parent, "llm", fn, input, output);
  };

  try {
    return { response: await attempt(task, full(primary, request.id), primary, false, options, onText), choice: primary };
  } catch (err) {
    const error = toAIError(err, primary.provider);
    if (error.kind === "cancelled" || options.control.stopped) throw error.kind === "cancelled" ? error : cancelledError(primary);
    if (shown || fallback.provider === primary.provider) throw error;
    const from = { provider: primary.provider, model: primary.model, error: error.message };
    if (!(await canUse(fallback))) {
      report("fallback", from, { skipped: true, reason: `${fallback.provider} is not connected` });
      throw new AIError(error.kind, `${error.message}\n${t("chat.noFallback", { provider: fallback.provider === "anthropic" ? "Anthropic API key" : "OpenAI" })}`, { provider: error.provider, status: error.status });
    }
    report("fallback", from, { provider: fallback.provider, model: fallback.model });
    try {
      const response = await attempt(task, full(fallback, `${request.id}-fallback`), fallback, true, options, onText);
      return { response, choice: fallback, fallbackFrom: { choice: primary, error } };
    } catch (err2) {
      const second = toAIError(err2, fallback.provider);
      if (second.kind === "cancelled") throw second;
      throw new AIError(second.kind, `${error.message}\n${t("chat.fallbackFailed", { provider: fallback.provider === "anthropic" ? "Claude" : "OpenAI", message: second.message })}`, {
        provider: second.provider,
        status: second.status,
      });
    }
  }
}
