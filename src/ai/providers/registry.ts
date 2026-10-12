import type { AIProvider, ProviderId } from "../types";
import { AnthropicProvider } from "./anthropic/anthropicProvider";
import { OpenAIProvider } from "./openai/openaiProvider";

/** All available providers. Adding a provider means adding an adapter here. */
export const PROVIDERS: Record<ProviderId, AIProvider> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
};
