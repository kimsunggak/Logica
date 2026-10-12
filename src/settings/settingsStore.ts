/**
 * User settings. Persisted as plain JSON (see storage/persistence.ts), so
 * this store must never hold credentials.
 */
import { create } from "zustand";
import { DEFAULT_MODEL_ID } from "../ai/models/modelConfig";
import type { ModelConfig, ProviderId } from "../ai/types";

export type ThemeSetting = "system" | "light" | "dark";
export type CompilerSetting = "auto" | "latexmk" | "pdflatex" | "xelatex" | "custom";

export interface AISettings {
  defaultProvider: ProviderId;
  /** Selected model per provider. */
  models: Record<ProviderId, string>;
  /** Model ids added by hand. */
  customModels: Record<ProviderId, string[]>;
  /** Last model list fetched from each provider's API. */
  fetchedModels: Record<ProviderId, ModelConfig[]>;
}

export interface EditorSettings {
  theme: ThemeSetting;
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
}

export interface LatexSettings {
  compiler: CompilerSetting;
  compilerPath: string;
  customCommand: string;
  autoCompile: boolean;
  timeoutSecs: number;
}

export interface Settings {
  ai: AISettings;
  editor: EditorSettings;
  latex: LatexSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  ai: {
    defaultProvider: "openai",
    models: { ...DEFAULT_MODEL_ID },
    customModels: { openai: [], anthropic: [] },
    fetchedModels: { openai: [], anthropic: [] },
  },
  editor: {
    theme: "system",
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    tabSize: 2,
    wordWrap: true,
  },
  latex: {
    compiler: "auto",
    compilerPath: "",
    customCommand: "latexmk -pdf -interaction=nonstopmode -file-line-error {main}",
    autoCompile: false,
    timeoutSecs: 120,
  },
};

interface SettingsStore extends Settings {
  updateAI(patch: Partial<AISettings>): void;
  updateEditor(patch: Partial<EditorSettings>): void;
  updateLatex(patch: Partial<LatexSettings>): void;
  replaceAll(settings: Settings): void;
}

export const useSettings = create<SettingsStore>()((set) => ({
  ...DEFAULT_SETTINGS,
  updateAI: (patch) => set((s) => ({ ai: { ...s.ai, ...patch } })),
  updateEditor: (patch) => set((s) => ({ editor: { ...s.editor, ...patch } })),
  updateLatex: (patch) => set((s) => ({ latex: { ...s.latex, ...patch } })),
  replaceAll: (settings) => set(settings),
}));

export function currentSettings(): Settings {
  const { ai, editor, latex } = useSettings.getState();
  return { ai, editor, latex };
}

/** Merge persisted settings over defaults, tolerating missing or old fields. */
export function mergeSettings(saved: unknown): Settings {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Settings>;
  const ai = (s.ai ?? {}) as Partial<AISettings>;
  return {
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...ai,
      models: { ...DEFAULT_SETTINGS.ai.models, ...(ai.models ?? {}) },
      customModels: { ...DEFAULT_SETTINGS.ai.customModels, ...(ai.customModels ?? {}) },
      fetchedModels: { ...DEFAULT_SETTINGS.ai.fetchedModels, ...(ai.fetchedModels ?? {}) },
      defaultProvider: ai.defaultProvider === "anthropic" ? "anthropic" : "openai",
    },
    editor: { ...DEFAULT_SETTINGS.editor, ...(s.editor ?? {}) },
    latex: { ...DEFAULT_SETTINGS.latex, ...(s.latex ?? {}) },
  };
}
