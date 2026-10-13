/**
 * User settings. Persisted as plain JSON (see storage/persistence.ts), so
 * this store must never hold credentials.
 */
import { create } from "zustand";
import { DEFAULT_MODEL_ID } from "../ai/models/modelConfig";
import type { AuthMethodKind, ModelConfig, ProviderId } from "../ai/types";
import { detectLanguage, type Language } from "../i18n/detect";

export type ThemeSetting = "system" | "light" | "dark";
export type CompilerSetting = "auto" | "latexmk" | "pdflatex" | "xelatex" | "custom";

export interface AISettings {
  defaultProvider: ProviderId;
  /** How LOGICA authenticates to OpenAI. */
  openaiAuth: AuthMethodKind;
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
  /** Save and compile shortly after typing stops. */
  livePreview: boolean;
  timeoutSecs: number;
}

export interface UISettings {
  language: Language;
}

export interface Settings {
  ui: UISettings;
  ai: AISettings;
  editor: EditorSettings;
  latex: LatexSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  ui: { language: detectLanguage() },
  ai: {
    defaultProvider: "openai",
    openaiAuth: "chatgpt",
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
    livePreview: true,
    timeoutSecs: 120,
  },
};

interface SettingsStore extends Settings {
  updateUI(patch: Partial<UISettings>): void;
  updateAI(patch: Partial<AISettings>): void;
  updateEditor(patch: Partial<EditorSettings>): void;
  updateLatex(patch: Partial<LatexSettings>): void;
  replaceAll(settings: Settings): void;
}

export const useSettings = create<SettingsStore>()((set) => ({
  ...DEFAULT_SETTINGS,
  updateUI: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
  updateAI: (patch) => set((s) => ({ ai: { ...s.ai, ...patch } })),
  updateEditor: (patch) => set((s) => ({ editor: { ...s.editor, ...patch } })),
  updateLatex: (patch) => set((s) => ({ latex: { ...s.latex, ...patch } })),
  replaceAll: (settings) => set(settings),
}));

export function currentSettings(): Settings {
  const { ui, ai, editor, latex } = useSettings.getState();
  return { ui, ai, editor, latex };
}

/** Defaults overlaid with the saved values of known keys only (drops retired settings). */
function pickKnown<T extends object>(defaults: T, saved: unknown): T {
  const result = { ...defaults };
  if (saved && typeof saved === "object") {
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      const value = (saved as Partial<T>)[key];
      if (value !== undefined) result[key] = value as T[keyof T];
    }
  }
  return result;
}

/** Merge persisted settings over defaults, tolerating missing or old fields. */
export function mergeSettings(saved: unknown): Settings {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<Settings>;
  const ai = (s.ai ?? {}) as Partial<AISettings>;
  const ui = (s.ui ?? {}) as Partial<UISettings>;
  return {
    ui: { language: ui.language === "ko" || ui.language === "en" ? ui.language : DEFAULT_SETTINGS.ui.language },
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...ai,
      models: { ...DEFAULT_SETTINGS.ai.models, ...(ai.models ?? {}) },
      customModels: { ...DEFAULT_SETTINGS.ai.customModels, ...(ai.customModels ?? {}) },
      fetchedModels: { ...DEFAULT_SETTINGS.ai.fetchedModels, ...(ai.fetchedModels ?? {}) },
      defaultProvider: ai.defaultProvider === "anthropic" ? "anthropic" : "openai",
      openaiAuth: ai.openaiAuth === "api_key" ? "api_key" : "chatgpt",
    },
    editor: { ...DEFAULT_SETTINGS.editor, ...(s.editor ?? {}) },
    latex: pickKnown(DEFAULT_SETTINGS.latex, s.latex),
  };
}
