/**
 * Tolerant BibTeX parser for citation autocomplete.
 *
 * Malformed entries are reported and skipped; parsing continues with the next
 * `@entry` so one broken entry never hides the rest of the bibliography.
 */
import { latexToPlain } from "../parser/text";

export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  venue?: string;
  filePath: string;
  line: number;
}

export interface BibParseError {
  filePath: string;
  line: number;
  message: string;
}

export interface BibParseResult {
  entries: BibEntry[];
  errors: BibParseError[];
}

const SKIPPED_TYPES = new Set(["comment", "preamble", "string"]);

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Read a `{...}` or `"..."` delimited value starting at `pos`. */
function readDelimited(text: string, pos: number): { value: string; end: number } | null {
  const open = text[pos];
  if (open === "{") {
    let depth = 0;
    for (let i = pos; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return { value: text.slice(pos + 1, i), end: i + 1 };
      } else if (ch === "@" && depth === 1 && text[i - 1] === "\n") {
        return null; // runaway value: next entry starts
      }
    }
    return null;
  }
  if (open === '"') {
    let depth = 0;
    for (let i = pos + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"' && depth === 0) return { value: text.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Index of the delimiter that closes the entry opened at `pos`. */
function findEntryEnd(text: string, pos: number, close: string): number {
  let depth = 0;
  let inQuote = false;
  for (let i = pos; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' && depth === 1 && close === "}") inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") {
      depth--;
      if (depth === 0) return ch === close || close === "}" ? i : -1;
    }
  }
  return -1;
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos < body.length) {
    const nameMatch = /\s*,?\s*([A-Za-z][\w:.-]*)\s*=\s*/y;
    nameMatch.lastIndex = pos;
    const m = nameMatch.exec(body);
    if (!m) break;
    const name = m[1].toLowerCase();
    pos = nameMatch.lastIndex;
    const parts: string[] = [];
    // value ( # value )*
    for (;;) {
      while (pos < body.length && /\s/.test(body[pos])) pos++;
      const ch = body[pos];
      if (ch === "{" || ch === '"') {
        const d = readDelimited(body, pos);
        if (!d) return fields;
        parts.push(d.value);
        pos = d.end;
      } else {
        const bare = /[^\s,#}]+/y;
        bare.lastIndex = pos;
        const b = bare.exec(body);
        if (!b) break;
        parts.push(b[0]);
        pos = bare.lastIndex;
      }
      while (pos < body.length && /\s/.test(body[pos])) pos++;
      if (body[pos] === "#") {
        pos++;
        continue;
      }
      break;
    }
    fields[name] = parts.join("");
    while (pos < body.length && body[pos] !== ",") pos++;
  }
  return fields;
}

export function parseBibtex(text: string, filePath: string): BibParseResult {
  const entries: BibEntry[] = [];
  const errors: BibParseError[] = [];
  const entryStart = /@\s*([A-Za-z]+)\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = entryStart.exec(text))) {
    const type = m[1].toLowerCase();
    const openPos = m.index + m[0].length - 1;
    const close = m[2] === "{" ? "}" : ")";
    const end = findEntryEnd(text, openPos, close);
    if (SKIPPED_TYPES.has(type)) {
      if (end > 0) entryStart.lastIndex = end + 1;
      continue;
    }
    const line = lineAt(text, m.index);
    if (end < 0) {
      errors.push({ filePath, line, message: `Unterminated @${type} entry` });
      // Resynchronise at the next entry.
      continue;
    }
    const body = text.slice(openPos + 1, end);
    const comma = body.indexOf(",");
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key || /[\s{}"]/.test(key)) {
      errors.push({ filePath, line, message: `Entry without a valid citation key (@${type})` });
      entryStart.lastIndex = end + 1;
      continue;
    }
    const fields = comma < 0 ? {} : parseFields(body.slice(comma + 1));
    entries.push({
      key,
      type,
      title: fields.title ? latexToPlain(fields.title) : undefined,
      author: fields.author ? cleanAuthors(fields.author) : fields.editor ? cleanAuthors(fields.editor) : undefined,
      year: fields.year ?? fields.date?.slice(0, 4),
      venue: latexToPlain(fields.journal ?? fields.booktitle ?? fields.journaltitle ?? fields.publisher ?? "") || undefined,
      filePath,
      line,
    });
    entryStart.lastIndex = end + 1;
  }
  return { entries, errors };
}

function cleanAuthors(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function lastName(author: string): string {
  const a = author.trim();
  if (a.includes(",")) return latexToPlain(a.split(",")[0]);
  // A braced group is a single name: {World Health Organization}
  if (/^\{.*\}$/.test(a)) return latexToPlain(a);
  const tokens = a.split(/\s+/);
  return latexToPlain(tokens[tokens.length - 1]);
}

/** "Vaswani et al." / "Smith and Jones" / "Smith" */
export function formatAuthors(authors?: string): string {
  if (!authors) return "";
  const list = authors.split(/\s+and\s+/i).filter(Boolean);
  const others = list.length > 0 && /^others$/i.test(list[list.length - 1].trim());
  const names = (others ? list.slice(0, -1) : list).map(lastName);
  if (names.length === 0) return "";
  if (names.length === 1) return others ? `${names[0]} et al.` : names[0];
  if (names.length === 2 && !others) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}
