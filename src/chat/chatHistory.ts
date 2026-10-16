/**
 * Saved conversations, one file per session in the app's local data folder
 * (`%LOCALAPPDATA%\app.logica.desktop\chats\<project id>\<session id>.json`
 * on Windows). Nothing leaves the computer except what is sent to the AI
 * provider when a message is asked.
 */
import { call } from "../lib/backend";

/** 2 adds the session summary; a version 1 file has none and is summarized again. */
export const SESSION_VERSION = 2;

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionFile<M> {
  version: number;
  createdAt: number;
  updatedAt: number;
  messages: M[];
  /** The session summary (`./session/summary.ts`), read with `readSummary`. */
  summary?: unknown;
}

export function listSessions(root: string): Promise<SessionSummary[]> {
  return call<SessionSummary[]>("chat_list_sessions", { root });
}

export function loadSession<M>(root: string, id: string): Promise<SessionFile<M> | null> {
  return call<SessionFile<M> | null>("chat_load_session", { root, id });
}

export function saveSession<M>(root: string, id: string, session: SessionFile<M>): Promise<void> {
  return call<void>("chat_save_session", { root, id, session });
}

export function deleteSession(root: string, id: string): Promise<void> {
  return call<void>("chat_delete_session", { root, id });
}

export function newSessionId(): string {
  return crypto.randomUUID();
}
