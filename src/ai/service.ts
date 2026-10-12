/**
 * AI service: the only entry point UI code uses to talk to AI providers.
 *
 *   Editor / Chat UI  →  aiService  →  AIProvider  →  OpenAI | Claude adapter
 */
import { AIError, toAIError } from "./errors";
import { PROVIDERS } from "./providers/registry";
import type { AIProvider, AIRequest, AIResponse, ModelConfig, ProviderId, StreamHandlers } from "./types";

let counter = 0;

export function newRequestId(): string {
  counter += 1;
  return `req-${Date.now().toString(36)}-${counter}`;
}

class AIService {
  private readonly active = new Map<string, ProviderId>();

  provider(id: ProviderId): AIProvider {
    const provider = PROVIDERS[id];
    if (!provider) throw new AIError("unknown", `Unknown AI provider: ${id}`);
    return provider;
  }

  async generate(providerId: ProviderId, request: AIRequest, handlers?: StreamHandlers): Promise<AIResponse> {
    if (!request.model) {
      throw new AIError("model_unavailable", "No model selected. Choose a model in Settings.", { provider: providerId });
    }
    this.active.set(request.id, providerId);
    try {
      return await this.provider(providerId).generate(request, handlers);
    } catch (err) {
      throw toAIError(err, providerId);
    } finally {
      this.active.delete(request.id);
    }
  }

  /** Stop a running generation. Safe to call for finished requests. */
  async cancel(requestId: string): Promise<void> {
    const providerId = this.active.get(requestId);
    if (!providerId) return;
    await this.provider(providerId).cancel?.(requestId);
  }

  isAuthenticated(providerId: ProviderId): Promise<boolean> {
    return this.provider(providerId).isAuthenticated();
  }

  async listModels(providerId: ProviderId): Promise<ModelConfig[]> {
    try {
      return (await this.provider(providerId).listModels?.()) ?? [];
    } catch (err) {
      throw toAIError(err, providerId);
    }
  }
}

export const aiService = new AIService();
