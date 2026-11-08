/**
 * Model configuration.
 *
 * Model ids are configuration data, kept only here. The shipped defaults are
 * a starting point; once a provider is connected, Settings refreshes the list
 * from the provider's models API, and users can add any model id by hand.
 */
import type { ChatTask, ModelConfig, ProviderId, ReasoningEffort } from "../types";

export const DEFAULT_MODELS: Record<ProviderId, ModelConfig[]> = {
  openai: [
    { id: "gpt-6.1-sol", provider: "openai", displayName: "GPT-6.1 Sol", supportsStreaming: true, source: "default" },
    { id: "gpt-6-sol", provider: "openai", displayName: "GPT-6 Sol", supportsStreaming: true, source: "default" },
    { id: "gpt-6-luna", provider: "openai", displayName: "GPT-6 Luna", supportsStreaming: true, source: "default" },
    { id: "gpt-6-astra", provider: "openai", displayName: "GPT-6 Astra", supportsStreaming: true, source: "default" },
  ],
  anthropic: [
    { id: "claude-sonnet-5-5", provider: "anthropic", displayName: "Claude Sonnet 5.5", supportsStreaming: true, source: "default" },
    { id: "claude-opus-5-5", provider: "anthropic", displayName: "Claude Opus 5.5", supportsStreaming: true, source: "default" },
    { id: "claude-haiku-5-5", provider: "anthropic", displayName: "Claude Haiku 5.5", supportsStreaming: true, source: "default" },
    { id: "claude-fable-5-1", provider: "anthropic", displayName: "Claude Fable 5.1", supportsStreaming: true, source: "default" },
  ],
};

export const DEFAULT_MODEL_ID: Record<ProviderId, string> = {
  openai: DEFAULT_MODELS.openai[0].id,
  anthropic: DEFAULT_MODELS.anthropic[0].id,
};

/**
 * Output token budget per task. Thinking counts toward it (for Claude it is
 * the hard limit on thinking plus the reply), so each budget leaves room to
 * think before answering. Every model in the default lists allows at least 64K.
 */
export const MAX_OUTPUT_TOKENS = {
  // One tool call with a one-sentence reason, after thinking at xhigh.
  judge: 32_000,
  // A one or two sentence reply to small talk.
  reply: 16_000,
  // One self-contained request as plain text.
  refine: 16_000,
  select: 16_000,
  // Findings for an edit, one line each, with their sources.
  research: 16_000,
  // Paper Chat answers; editing has its own task and tool call.
  answer: 64_000,
  // Every change of a request in one tool call, up to a whole draft.
  edit: 64_000,
  // One tool call with the changes to the session summary.
  summary: 16_000,
  // One tool call with a few sentences per section of a batch.
  sections: 16_000,
} as const;

/** Output limit at xhigh and max effort: the maximum output of current Claude models and gpt-6.1-sol. */
export const HIGH_EFFORT_OUTPUT_TOKENS = 128_000;

/** Output limit of one call: 128K when the model thinks at xhigh or max, otherwise the task's budget. */
export function maxOutputTokens(task: ChatTask, effort?: ReasoningEffort): number {
  return effort === "xhigh" || effort === "max" ? HIGH_EFFORT_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS[task];
}

/**
 * Most web searches one call may run, for the tasks that cap them. One
 * Research call answers all its questions within this limit (Claude's
 * web search tool has the same limit for every call).
 */
export const MAX_SEARCHES: Partial<Record<ChatTask, number>> = {
  research: 5,
};

export interface ModelChoice {
  provider: ProviderId;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

const CLAUDE_FALLBACK: ModelChoice = { provider: "anthropic", model: "claude-sonnet-5-5" };

/** The chat tasks whose model the user picks in Settings: the Paper Chat answer and the edit. */
export type ChosenModelTask = "answer" | "edit";

/**
 * Primary and fallback models for the internal chat calls. The LLM Gateway
 * retries with the fallback provider when the primary call fails. The answer
 * and the edit follow the model and reasoning effort chosen in Settings (`chosenModels`).
 */
export const CHAT_MODELS: Record<Exclude<ChatTask, ChosenModelTask>, { primary: ModelChoice; fallback: ModelChoice }> = {
  judge: {
    primary: { provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "xhigh" },
    fallback: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" },
  },
  reply: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }, fallback: CLAUDE_FALLBACK },
  refine: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }, fallback: CLAUDE_FALLBACK },
  select: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }, fallback: CLAUDE_FALLBACK },
  // Searches the web before an edit, only when section selection asks for it.
  research: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "medium" }, fallback: CLAUDE_FALLBACK },
  // Runs in the background once ten turns are not in the session summary, or they run long.
  summary: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }, fallback: CLAUDE_FALLBACK },
  // Runs in the background after a turn that read the paper, for sections without a summary.
  sections: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }, fallback: CLAUDE_FALLBACK },
};

/** Reasoning effort chosen for each provider until the user picks another. */
export const DEFAULT_REASONING: Record<ProviderId, ReasoningEffort> = { openai: "medium", anthropic: "medium" };

/**
 * Models of the answer and the edit: the default provider with the model and
 * reasoning effort chosen for it in Settings, falling back to the other
 * provider's chosen model and effort.
 */
export function chosenModels(
  defaultProvider: ProviderId,
  models: Record<ProviderId, string>,
  reasoning: Record<ProviderId, ReasoningEffort> = DEFAULT_REASONING,
): { primary: ModelChoice; fallback: ModelChoice } {
  const other: ProviderId = defaultProvider === "openai" ? "anthropic" : "openai";
  return {
    primary: { provider: defaultProvider, model: models[defaultProvider], reasoningEffort: reasoning[defaultProvider] },
    fallback: { provider: other, model: models[other], reasoningEffort: reasoning[other] },
  };
}

/**
 * OpenAI's models endpoint also lists embedding, audio, image and moderation
 * models; keep only text generation models usable with the Responses API.
 */
export function isOpenAITextModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/.test(id)) return false;
  return !/(embedding|audio|realtime|tts|transcribe|whisper|image|dall-e|moderation|search|instruct|-diarize)/.test(id);
}

/** Merge shipped defaults, API-listed models and user-added ids (deduplicated). */
export function mergeModels(
  provider: ProviderId,
  fetched: ModelConfig[] | undefined,
  custom: string[] | undefined,
): ModelConfig[] {
  const byId = new Map<string, ModelConfig>();
  for (const m of DEFAULT_MODELS[provider]) byId.set(m.id, m);
  for (const m of fetched ?? []) byId.set(m.id, { ...byId.get(m.id), ...m });
  for (const id of custom ?? []) {
    if (!byId.has(id)) {
      byId.set(id, { id, provider, displayName: id, supportsStreaming: true, source: "custom" });
    }
  }
  return [...byId.values()];
}
