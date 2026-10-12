/**
 * Connection status of each AI provider, shown in Settings and next to the
 * provider pickers. Only status information lives here, never secrets.
 */
import { create } from "zustand";
import { getChatGPTStatus, getCredentialStatus } from "../ai/credentials/credentialStore";
import { PROVIDER_IDS, type AuthMethodKind, type ChatGPTStatus, type CredentialStatus, type ProviderId } from "../ai/types";
import { errorMessage } from "../lib/backend";

export interface ProviderConnection {
  /** API key status. */
  status: CredentialStatus | null;
  /** Sign in with ChatGPT status (OpenAI only). */
  chatgpt?: ChatGPTStatus | null;
  /** Result of the last connection test (models API call). */
  verified?: boolean;
  testError?: string;
  loading: boolean;
}

type Connections = Record<ProviderId, ProviderConnection>;

export const useConnections = create<Connections>()(() => ({
  openai: { status: null, loading: false },
  anthropic: { status: null, loading: false },
}));

export function setConnection(provider: ProviderId, patch: Partial<ProviderConnection>) {
  useConnections.setState((s) => ({ [provider]: { ...s[provider], ...patch } }) as Partial<Connections>);
}

export async function refreshConnection(provider: ProviderId): Promise<void> {
  setConnection(provider, { loading: true });
  try {
    const [status, chatgpt] = await Promise.all([
      getCredentialStatus(provider),
      provider === "openai" ? getChatGPTStatus().catch(() => null) : Promise.resolve(undefined),
    ]);
    setConnection(provider, { status, chatgpt, loading: false });
  } catch (err) {
    setConnection(provider, {
      loading: false,
      status: {
        provider,
        stored: false,
        method: null,
        hint: null,
        storeAvailable: false,
        error: errorMessage(err),
      },
    });
  }
}

export function refreshAllConnections(): Promise<void[]> {
  return Promise.all(PROVIDER_IDS.map(refreshConnection));
}

/** Whether the provider can be used with its active authentication method. */
export function isConnected(provider: ProviderId, connection: ProviderConnection, openaiAuth: AuthMethodKind): boolean {
  if (provider === "openai" && openaiAuth === "chatgpt") {
    return Boolean(connection.chatgpt?.connected && connection.chatgpt.planUsage);
  }
  return Boolean(connection.status?.stored);
}

/** Whether the connection status has been loaded at least once. */
export function isKnown(connection: ProviderConnection): boolean {
  return connection.status !== null;
}
