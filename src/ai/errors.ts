import type { ProviderId } from "./types";

export type AIErrorKind =
  | "no_credential"
  | "store_unavailable"
  | "auth"
  | "permission"
  | "rate_limit"
  | "quota"
  | "network"
  | "timeout"
  | "unavailable"
  | "model_unavailable"
  | "bad_request"
  | "cancelled"
  | "malformed_response"
  | "stream_interrupted"
  | "not_desktop"
  | "unknown";

/** Normalized, user-presentable AI error. Never contains credentials. */
export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly provider?: ProviderId;
  readonly status?: number;

  constructor(kind: AIErrorKind, message: string, options: { provider?: ProviderId; status?: number } = {}) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
    this.provider = options.provider;
    this.status = options.status;
  }

  /** Whether trying again later (or with another provider) may help. */
  get retryable(): boolean {
    return ["rate_limit", "network", "timeout", "unavailable", "stream_interrupted"].includes(this.kind);
  }
}

const PROVIDER_NAMES: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
};

/** Error shape produced by the Rust backend commands. */
export interface BackendError {
  kind: string;
  message: string;
  status?: number;
  body?: string;
}

export function isBackendError(value: unknown): value is BackendError {
  return typeof value === "object" && value !== null && "kind" in value && "message" in value;
}

interface ProviderErrorBody {
  type?: string;
  code?: string;
  message?: string;
}

function parseErrorBody(body?: string): ProviderErrorBody {
  if (!body) return {};
  try {
    const json = JSON.parse(body);
    const err = json?.error ?? json;
    return {
      type: typeof err?.type === "string" ? err.type : undefined,
      code: typeof err?.code === "string" ? err.code : undefined,
      message: typeof err?.message === "string" ? err.message : undefined,
    };
  } catch {
    return { message: body.slice(0, 300) };
  }
}

/** Map an HTTP error from a provider to an AIError. */
export function fromHttpError(provider: ProviderId, status: number, body?: string): AIError {
  const name = PROVIDER_NAMES[provider];
  const parsed = parseErrorBody(body);
  const detail = parsed.message ? ` (${parsed.message})` : "";
  const type = `${parsed.type ?? ""} ${parsed.code ?? ""}`;
  const text = `${type} ${parsed.message ?? ""}`.toLowerCase();
  const opts = { provider, status };

  if (status === 401 || /authentication_error|invalid_api_key/.test(type)) {
    return new AIError("auth", `${name} rejected the API key. It may be invalid, revoked or expired.`, opts);
  }
  if (/insufficient_quota|billing|credit balance/.test(text)) {
    return new AIError("quota", `${name}: insufficient quota or credit balance${detail}.`, opts);
  }
  if (status === 429 || /rate_limit/.test(type)) {
    return new AIError("rate_limit", `${name} rate limit reached. Wait a moment and try again.`, opts);
  }
  const unknownModel = status === 400 && /model/.test(text) && /does not exist|not found|not supported|invalid model/.test(text);
  if (status === 404 || /model_not_found|not_found_error/.test(type) || unknownModel) {
    return new AIError("model_unavailable", `The selected ${name} model is not available for this account${detail}.`, opts);
  }
  if (status === 403 || /permission/.test(type)) {
    return new AIError("permission", `${name} denied access${detail}.`, opts);
  }
  if (status === 529 || status >= 500 || /overloaded/.test(type)) {
    return new AIError("unavailable", `${name} is temporarily unavailable (HTTP ${status}). Try again shortly.`, opts);
  }
  if (status === 400 || status === 413 || status === 422) {
    return new AIError("bad_request", `${name} rejected the request${detail}.`, opts);
  }
  return new AIError("unknown", `${name} returned HTTP ${status}${detail}.`, opts);
}

/** Map an error event received inside a stream. */
export function fromStreamError(provider: ProviderId, payload: { type?: string; code?: string; message?: string }): AIError {
  const type = `${payload.type ?? ""} ${payload.code ?? ""}`;
  const status = /overloaded/.test(type)
    ? 529
    : /rate_limit/.test(type)
      ? 429
      : /insufficient_quota/.test(type)
        ? 429
        : /authentication/.test(type)
          ? 401
          : /not_found|model/.test(type)
            ? 404
            : /invalid_request/.test(type)
              ? 400
              : 500;
  return fromHttpError(provider, status, JSON.stringify({ error: payload }));
}

/** Convert anything thrown by the transport into an AIError. */
export function toAIError(err: unknown, provider?: ProviderId): AIError {
  if (err instanceof AIError) return err;
  if (isBackendError(err)) {
    switch (err.kind) {
      case "http_error":
        return provider && err.status
          ? fromHttpError(provider, err.status, err.body)
          : new AIError("unknown", err.message, { provider, status: err.status });
      case "no_credential":
        return new AIError("no_credential", err.message, { provider });
      case "store_unavailable":
        return new AIError("store_unavailable", err.message, { provider });
      case "cancelled":
        return new AIError("cancelled", "Generation cancelled.", { provider });
      case "timeout":
        return new AIError("timeout", "The request timed out.", { provider });
      case "network":
        return new AIError("network", "Network error. Check your internet connection.", { provider });
      case "stream_interrupted":
        return new AIError("stream_interrupted", "The response stream was interrupted.", { provider });
      case "malformed_response":
        return new AIError("malformed_response", "The provider returned a malformed response.", { provider });
      default:
        return new AIError("unknown", err.message, { provider });
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AIError("unknown", message, { provider });
}
