/**
 * Single entry point for calling the Rust backend.
 *
 * Inside the desktop app this forwards to Tauri's IPC. When the frontend is
 * opened in a plain browser during development (`npm run dev`), calls are
 * served by an in-memory demo backend so the UI can be exercised without the
 * native shell. The demo backend is never bundled into production builds.
 */
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { currentLanguage, t, type MessageKey } from "../i18n";

export interface DemoBackend {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  openFolderDialog(): Promise<string | null>;
}

let demo: Promise<DemoBackend> | null = null;

export function isDesktop(): boolean {
  return isTauri();
}

/** True when running in a browser with the development demo backend. */
export function isDemoMode(): boolean {
  return !isTauri() && import.meta.env.DEV;
}

async function demoBackend(): Promise<DemoBackend> {
  if (!import.meta.env.DEV) {
    throw { kind: "not_desktop", message: "LOGICA must run as a desktop app (npm run tauri dev)." };
  }
  demo ??= import("../dev/demoBackend").then((m) => m.createDemoBackend());
  return demo;
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args);
  return (await demoBackend()).invoke(cmd, args) as Promise<T>;
}

/** A message channel from the backend to the webview (used for streaming). */
export function createChannel<T>(onMessage: (message: T) => void): unknown {
  if (isTauri()) {
    const channel = new Channel<T>();
    channel.onmessage = onMessage;
    return channel;
  }
  return { demoChannel: true, onmessage: onMessage };
}

export async function pickProjectFolder(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "Open LaTeX project folder" });
    return typeof selected === "string" ? selected : null;
  }
  return (await demoBackend()).openFolderDialog();
}

export async function confirmDialog(message: string, title = "LOGICA"): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title, kind: "warning" });
  }
  return window.confirm(message);
}

/** Open a web page in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Fixed backend messages (Rust side is English only) and their UI translation. */
const BACKEND_MESSAGES: Record<string, MessageKey> = {
  "Could not reach auth.openai.com. Check your connection.": "ai.err.chatgptUnreachable",
  "Your ChatGPT connection has expired. Sign in with ChatGPT again.": "ai.err.chatgptExpired",
  "ChatGPT sign-in timed out. Please try again.": "ai.err.chatgptTimeout",
  "The browser could not be opened. Check your default browser and try again.": "ai.err.browser",
  "Sign in with ChatGPT in Settings to use your ChatGPT plan.": "ai.err.chatgptSignIn",
  "You are signed in, but ChatGPT plan usage was not granted to LOGICA. Sign in again and allow plan usage.": "settings.planUsageMissing",
  "No LaTeX compiler found (latexmk, pdflatex or xelatex). Install TeX Live, MacTeX or MiKTeX, or set the compiler path in Settings.":
    "compile.notFound",
};

/** Fallback by error kind when the backend message carries no extra detail worth keeping. */
const BACKEND_KINDS: Record<string, MessageKey> = {
  network: "ai.err.network",
  timeout: "ai.err.timeout",
  chatgpt_expired: "ai.err.chatgptExpired",
  browser_unavailable: "ai.err.browser",
  store_unavailable: "ai.err.storeUnavailable",
  invalid_secret: "ai.err.invalidKey",
};

/** Extract a readable message from anything a backend call may throw. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = String((err as { message: unknown }).message);
    if (currentLanguage() === "en") return message;
    const known = BACKEND_MESSAGES[message];
    if (known) return t(known);
    const notConnected = /^(.+) is not connected\. Add an API key in Settings\.$/.exec(message);
    if (notConnected) return t("ai.err.noCredential", { provider: notConnected[1] });
    const kind = errorKind(err);
    if (kind && BACKEND_KINDS[kind]) return t(BACKEND_KINDS[kind]);
    if (kind === "chatgpt_auth") return `${t("ai.err.chatgptFailed")} (${message})`;
    return message;
  }
  return String(err);
}

export function errorKind(err: unknown): string | undefined {
  if (err && typeof err === "object" && "kind" in err) return String((err as { kind: unknown }).kind);
  return undefined;
}
