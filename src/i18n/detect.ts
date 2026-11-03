export type Language = "ko" | "en";

/** Initial UI language: Korean when the system language is Korean. */
export function detectLanguage(): Language {
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  return lang?.toLowerCase().startsWith("ko") ? "ko" : "en";
}
