/**
 * Connection status of each AI provider, shown in Settings and next to the
 * provider pickers. Only status information lives here, never secrets.
 */
import { create } from "zustand";
import { getCredentialStatus } from "../ai/credentials/credentialStore";
import { PROVIDER_IDS, type CredentialStatus, type ProviderId } from "../ai/types";
import { errorMessage } from "../lib/backend";

export interface ProviderConnection {
  status: CredentialStatus | null;
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
    const status = await getCredentialStatus(provider);
    setConnection(provider, { status, loading: false });
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

export function isConnected(connection: ProviderConnection): boolean {
  return Boolean(connection.status?.stored);
}
