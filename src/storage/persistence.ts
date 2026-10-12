/**
 * Loads and saves non-secret application state through the backend
 * (`state.json` in the app config folder). Credentials are never part of it.
 */
import { call } from "../lib/backend";
import { currentSettings, mergeSettings, useSettings } from "../settings/settingsStore";
import { currentWorkspace, mergeWorkspace, useWorkspace } from "./workspaceStore";

const STATE_VERSION = 1;
const SAVE_DELAY_MS = 600;

/** Property names that must never be persisted, as a defense against accidents. */
const SECRET_KEY_PATTERN = /^(api[-_]?key|secret|token|access[-_]?token|refresh[-_]?token|password|credential)$/i;

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      out[key] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

export async function loadPersistedState(): Promise<void> {
  try {
    const saved = await call<{ settings?: unknown; workspace?: unknown } | null>("load_app_state");
    useSettings.getState().replaceAll(mergeSettings(saved?.settings));
    useWorkspace.getState().replaceAll(mergeWorkspace(saved?.workspace));
  } catch (err) {
    console.warn("Could not load saved state; using defaults.", err);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const state = stripSecrets({ version: STATE_VERSION, settings: currentSettings(), workspace: currentWorkspace() });
    call("save_app_state", { state }).catch((err) => console.warn("Could not save state", err));
  }, SAVE_DELAY_MS);
}

export function startPersistence(): () => void {
  const unsubSettings = useSettings.subscribe(scheduleSave);
  const unsubWorkspace = useWorkspace.subscribe(scheduleSave);
  return () => {
    unsubSettings();
    unsubWorkspace();
  };
}
