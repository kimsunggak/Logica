/**
 * Frontend view of provider credentials.
 *
 * Secrets are handed to the backend once (when the user saves a key) and are
 * stored in the OS credential store. They are never read back, persisted in
 * app state, or logged.
 */
import { call } from "../../lib/backend";
import type { CredentialStatus, ProviderId } from "../types";

export function getCredentialStatus(provider: ProviderId): Promise<CredentialStatus> {
  return call<CredentialStatus>("credential_status", { provider });
}

export function saveApiKey(provider: ProviderId, apiKey: string): Promise<CredentialStatus> {
  return call<CredentialStatus>("credential_set", { provider, secret: apiKey });
}

/** Disconnect: permanently removes the credential from the OS store. */
export function deleteCredential(provider: ProviderId): Promise<void> {
  return call<void>("credential_delete", { provider });
}
