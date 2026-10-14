/**
 * Model configuration.
 *
 * Model ids are configuration data, kept only here. The shipped defaults are
 * a starting point; once a provider is connected, Settings refreshes the list
 * from the provider's models API, and users can add any model id by hand.
 */
import type { ModelConfig, ProviderId } from "../types";

export const DEFAULT_MODELS: Record<ProviderId, ModelConfig[]> = {
  openai: [
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

/** Output token budget per task. */
export const MAX_OUTPUT_TOKENS = {
  "inline-edit": 8192,
  // Agent answers may carry edits for several places and files.
  chat: 16384,
  // A short JSON reply naming sections.
  select: 1024,
  answer: 8192,
} as const;

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
