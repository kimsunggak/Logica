import type { HighlighterCore } from "@shikijs/core";
import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import type { CodeHighlighterPlugin } from "streamdown";

/**
 * Code highlighting for chat answers. Streamdown's own code plugin bundles
 * every Shiki grammar (hundreds of files in the app bundle); this one knows
 * only the languages a LaTeX writer meets, each loaded on first use.
 */

type Grammar = () => Promise<{ default: unknown }>;

const GRAMMARS: Record<string, Grammar> = {
  latex: () => import("@shikijs/langs/latex"),
  bibtex: () => import("@shikijs/langs/bibtex"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  julia: () => import("@shikijs/langs/julia"),
  matlab: () => import("@shikijs/langs/matlab"),
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  markdown: () => import("@shikijs/langs/markdown"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  java: () => import("@shikijs/langs/java"),
  diff: () => import("@shikijs/langs/diff"),
};

const ALIASES: Record<string, string> = {
  tex: "latex",
  bib: "bibtex",
  py: "python",
  js: "javascript",
  ts: "typescript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  md: "markdown",
  yml: "yaml",
  "c++": "cpp",
  m: "matlab",
};

const THEMES = ["github-light", "github-dark"] as const;
/** Finished blocks kept highlighted; old answers rarely come back into view. */
const CACHE_LIMIT = 200;

type Tokens = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

export function resolveLanguage(language: string): string | null {
  const id = language.trim().toLowerCase();
  const resolved = ALIASES[id] ?? id;
  return resolved in GRAMMARS ? resolved : null;
}

let highlighter: Promise<HighlighterCore> | null = null;
const loading = new Map<string, Promise<void>>();
const cache = new Map<string, Tokens>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

async function withLanguage(lang: string): Promise<HighlighterCore> {
  const core = await getHighlighter();
  if (!loading.has(lang)) loading.set(lang, core.loadLanguage(GRAMMARS[lang]() as never));
  await loading.get(lang);
  return core;
}

function remember(key: string, tokens: Tokens) {
  cache.set(key, tokens);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export const codeHighlighter: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage: (language) => resolveLanguage(language) !== null,
  getSupportedLanguages: () => Object.keys(GRAMMARS) as ReturnType<CodeHighlighterPlugin["getSupportedLanguages"]>,
  getThemes: () => [...THEMES],
  highlight({ code, language, isIncomplete }, callback) {
    const lang = resolveLanguage(language);
    if (!lang) return null;
    const key = `${lang}\n${code}`;
    const hit = cache.get(key);
    if (hit) return hit;
    withLanguage(lang)
      .then((core) => {
        const tokens = core.codeToTokens(code, { lang, themes: { light: THEMES[0], dark: THEMES[1] } }) as Tokens;
        // A block still streaming is replaced by its next version; do not keep it.
        if (!isIncomplete) remember(key, tokens);
        callback?.(tokens);
      })
      .catch((e: unknown) => console.warn("Chat code highlighting failed:", e));
    return null;
  },
};
