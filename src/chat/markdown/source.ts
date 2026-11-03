/** Turning chat answer text into the Markdown the renderer gets. */

/**
 * Models often write math as \( ... \) and \[ ... \], which Markdown reads as
 * escaped brackets. Rewrite them to the $ ... $ and $$ ... $$ forms the math
 * plugin understands. Inline code is left alone (fenced code never reaches
 * here: the chat splits it off first).
 */
const PATTERN = /(`+)[\s\S]*?\1|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;

export function normalizeMath(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  return markdown.replace(PATTERN, (match, ticks: string | undefined, display: string | undefined, inline: string | undefined) => {
    if (ticks) return match;
    if (display !== undefined) return `\n\n$$\n${display.trim()}\n$$\n\n`;
    return `$${(inline ?? "").trim()}$`;
  });
}

/** A code block as Markdown, fenced longer than any backtick run inside it. */
export function fencedCode(code: string, lang = ""): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}
