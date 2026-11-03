/**
 * Frontend view of provider credentials.
 *
 * Secrets are handed to the backend once (when the user saves a key) and are
 * stored in the OS credential store. They are never read back, persisted in
 * app state, or logged.
 */
import { call } from "../../lib/backend";
import type { ChatGPTStatus, CredentialStatus, ProviderId } from "../types";

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

// Sign in with ChatGPT. The OAuth flow runs in the backend; tokens stay there.

export function getChatGPTStatus(): Promise<ChatGPTStatus> {
  return call<ChatGPTStatus>("chatgpt_status");
}

/** Opens the browser and resolves once the user has signed in (or failed). */
export function signInWithChatGPT(): Promise<ChatGPTStatus> {
  return call<ChatGPTStatus>("chatgpt_sign_in");
}

export function cancelChatGPTSignIn(): Promise<boolean> {
  return call<boolean>("chatgpt_cancel_sign_in");
}

/** Revokes the session at OpenAI and deletes the tokens from the OS store. */
export function signOutOfChatGPT(): Promise<{ revoked: boolean }> {
  return call<{ revoked: boolean }>("chatgpt_sign_out");
}
