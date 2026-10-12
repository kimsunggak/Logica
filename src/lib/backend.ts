/**
 * Single entry point for calling the Rust backend.
 *
 * Inside the desktop app this forwards to Tauri's IPC. When the frontend is
 * opened in a plain browser during development (`npm run dev`), calls are
 * served by an in-memory demo backend so the UI can be exercised without the
 * native shell. The demo backend is never bundled into production builds.
 */
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

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

/** Extract a readable message from anything a backend call may throw. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

export function errorKind(err: unknown): string | undefined {
  if (err && typeof err === "object" && "kind" in err) return String((err as { kind: unknown }).kind);
  return undefined;
}
