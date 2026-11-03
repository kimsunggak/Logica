/**
 * Transport between provider adapters and the Rust AI proxy.
 *
 * Adapters send a provider-specific JSON body; the backend attaches the
 * credential, calls the allowlisted endpoint and streams the raw response
 * body back. Credentials never pass through this layer.
 */
import { call, createChannel } from "../../lib/backend";
import { toAIError } from "../errors";
import type { AuthMethodKind, ProviderId } from "../types";

type RawStreamEvent = { type: "open"; status: number } | { type: "chunk"; data: string } | { type: "done" };

export interface StreamOptions {
  requestId: string;
  provider: ProviderId;
  path: string;
  body: Record<string, unknown>;
  /** Credential to attach (OpenAI only); defaults to the API key. */
  auth?: AuthMethodKind;
  onChunk: (text: string) => void;
}

/** Resolves once the full response body has been delivered to `onChunk`. */
export async function streamProviderRequest(options: StreamOptions): Promise<void> {
  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => (markDone = resolve));
  const channel = createChannel<RawStreamEvent>((event) => {
    if (event.type === "chunk") options.onChunk(event.data);
    else if (event.type === "done") markDone();
  });
  try {
    await call<void>("ai_stream", {
      request: {
        requestId: options.requestId,
        provider: options.provider,
        path: options.path,
        body: options.body,
        auth: options.auth ?? null,
      },
      onEvent: channel,
    });
  } catch (err) {
    throw toAIError(err, options.provider);
  }
  // Channel messages and the command result travel separately; make sure
  // every chunk has been processed before reporting completion.
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

export async function cancelProviderRequest(requestId: string): Promise<void> {
  await call<boolean>("ai_cancel", { requestId }).catch(() => false);
}

export async function providerGet<T>(provider: ProviderId, path: string, auth?: AuthMethodKind): Promise<T> {
  try {
    return await call<T>("ai_get", { provider, path, auth: auth ?? null });
  } catch (err) {
    throw toAIError(err, provider);
  }
}
