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

/** Output token budget per task (reasoning models spend part of it thinking first). */
export const MAX_OUTPUT_TOKENS = {
  "inline-edit": 8192,
  // One tool call with a one-sentence reason.
  judge: 4096,
  // A one or two sentence reply to small talk.
  reply: 4096,
  // One rewritten question as JSON.
  refine: 8192,
  // Answers may carry edits for several places and files.
  answer: 16384,
} as const;

export interface ModelChoice {
  provider: ProviderId;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

const CLAUDE_FALLBACK: ModelChoice = { provider: "anthropic", model: "claude-sonnet-5-5" };

/**
 * Primary and fallback models for each chat call. The LLM Gateway retries
 * with the fallback provider when the primary call fails.
 */
export const CHAT_MODELS: Record<ChatTask, { primary: ModelChoice; fallback: ModelChoice }> = {
  judge: {
    primary: { provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "high" },
    fallback: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" },
  },
  reply: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "low" }, fallback: CLAUDE_FALLBACK },
  refine: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "medium" }, fallback: CLAUDE_FALLBACK },
  answer: { primary: { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "medium" }, fallback: CLAUDE_FALLBACK },
};

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
