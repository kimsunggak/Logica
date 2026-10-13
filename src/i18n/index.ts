/**
 * UI language (Korean / English).
 *
 * Messages live in ./messages.ts. `t()` works anywhere (stores, actions);
 * components call `useT()` so they re-render when the language changes.
 * AI prompts are not translated: they are instructions to the model.
 */
import { useSettings } from "../settings/settingsStore";
import { messages, type MessageKey } from "./messages";

import type { Language } from "./detect";

export type { Language } from "./detect";
export { detectLanguage } from "./detect";

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
];

export type Params = Record<string, string | number>;

export function translate(language: Language, key: MessageKey, params?: Params): string {
  let text: string = messages[language][key] ?? messages.en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export function currentLanguage(): Language {
  return useSettings.getState().ui.language;
}

/** Translate with the current language (for code outside React components). */
export function t(key: MessageKey, params?: Params): string {
  return translate(currentLanguage(), key, params);
}

/** Translation function bound to the current language; re-renders on change. */
export function useT(): (key: MessageKey, params?: Params) => string {
  const language = useSettings((s) => s.ui.language);
  return (key, params) => translate(language, key, params);
}

export type { MessageKey };
