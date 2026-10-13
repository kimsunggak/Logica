/**
 * Multi-place edits proposed by the chat agent.
 *
 * The model answers with one fenced block per change:
 *
 *   ```edit sections/method.tex
 *   <<<<<<< ORIGINAL
 *   exact text copied from the file
 *   =======
 *   replacement text
 *   >>>>>>> REVISED
 *   ```
 *
 * Nothing is applied automatically: each block is shown as a diff and the
 * author accepts or rejects it.
 */

export interface ProposedEdit {
  path: string;
  original: string;
  revised: string;
}

const BODY = /^<{7} ?ORIGINAL[^\n]*\n([\s\S]*?)\n?={7}[^\n]*\n([\s\S]*?)\n?>{7} ?REVISED[^\n]*\s*$/;

/** Parse the body of an ```edit block (null when it is not a complete block). */
export function parseEditBody(path: string, body: string): ProposedEdit | null {
  const m = BODY.exec(body.trim());
  if (!m || !path || !m[1].trim()) return null;
  return { path: path.trim(), original: m[1], revised: m[2] };
}

export interface Located {
  from: number;
  to: number;
}

/**
 * Find where `original` sits in `text`. An exact, unique match wins; otherwise
 * the match may differ in whitespace only (models often re-wrap lines). Null
 * when the text is missing or ambiguous.
 */
export function locateEdit(text: string, original: string): Located | null {
  const exact = allIndexes(text, original);
  if (exact.length === 1) return { from: exact[0], to: exact[0] + original.length };
  if (exact.length > 1) return null;

  const words = original.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "g");
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const from = matches[0].index ?? 0;
  return { from, to: from + matches[0][0].length };
}

function allIndexes(text: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let i = text.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return found;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1-based line number of an offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
