/**
 * Extract the relevant problems from a LaTeX `.log` file so the user sees
 * "sections/method.tex:42  Undefined control sequence \foo" instead of the
 * raw terminal output.
 */
import { joinPath, normalizePath } from "../parser/text";
import { t } from "../../i18n";

export interface LogItem {
  severity: "error" | "warning";
  message: string;
  /** Project-relative file path when known. */
  file?: string;
  line?: number;
  /** Source excerpt reported by TeX (`l.42 \foo`). */
  context?: string;
  hint?: string;
}

export interface ParsedLog {
  errors: LogItem[];
  warnings: LogItem[];
  missingPackages: string[];
}

const MAX_PRINT_LINE = 79;
const MAX_ITEMS = 30;

/**
 * TeX wraps log lines at 79 characters; join them back. Error context lines
 * (`l.42 ...` and the indented line after it) are padded rather than wrapped,
 * so they are never joined with what follows.
 */
function unwrap(log: string): string[] {
  const raw = log.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let buffer = "";
  for (const line of raw) {
    const isContext = /^l\.\d+/.test(line) || (buffer === "" && /^\s/.test(line));
    buffer += line;
    if (line.length === MAX_PRINT_LINE && !isContext) continue;
    out.push(buffer);
    buffer = "";
  }
  if (buffer) out.push(buffer);
  return out;
}

const MAX_CONTEXT = 160;

function toProjectPath(file: string, mainDir: string): string {
  const cleaned = file.trim().replace(/^"|"$/g, "");
  if (cleaned.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleaned)) return normalizePath(cleaned);
  return joinPath(mainDir, cleaned);
}

function hintFor(message: string): { hint?: string; pkg?: string } {
  const missing = /File [`'"]?([^`'"]+?\.(?:sty|cls))['"]? not found/.exec(message);
  if (missing) {
    const pkg = missing[1];
    return {
      pkg,
      hint: t("log.missingPackage", { pkg, name: pkg.replace(/\.(sty|cls)$/, "") }),
    };
  }
  if (/Unicode character .*\(U\+(?:AC|AD|AE|AF|B[0-9A-F]|C[0-9A-F]|D[0-7]|11|31)[0-9A-F]{2}\)/.test(message)) {
    return { hint: t("log.korean") };
  }
  if (/Unicode character .* not set up|Unicode character .*\(U\+[0-9A-F]+\)/.test(message)) {
    return { hint: t("log.unicode") };
  }
  const picture = /Unable to load picture or PDF file '([^']+)'/.exec(message);
  if (picture) {
    return { hint: t("log.pictureMissing", { file: picture[1] }) };
  }
  if (/Undefined control sequence/.test(message)) {
    return { hint: t("log.undefinedCommand") };
  }
  if (/Missing \$ inserted/.test(message)) {
    return { hint: t("log.missingDollar") };
  }
  if (/Missing \} inserted|Extra \}|Missing \{ inserted/.test(message)) {
    return { hint: t("log.braces") };
  }
  if (/\\begin\{[^}]*\} on input line \d+ ended by \\end/.test(message)) {
    return { hint: t("log.environment") };
  }
  if (/File [`'"]?[^`'"]+['"]? not found/.test(message)) {
    return { hint: t("log.fileNotFound") };
  }
  return {};
}

export function parseLatexLog(log: string, mainFile = "main.tex"): ParsedLog {
  const mainDir = mainFile.includes("/") ? mainFile.slice(0, mainFile.lastIndexOf("/")) : "";
  const lines = unwrap(log);
  const errors: LogItem[] = [];
  const warnings: LogItem[] = [];
  const missingPackages = new Set<string>();
  const seen = new Set<string>();

  const push = (list: LogItem[], item: LogItem) => {
    const key = `${item.severity}|${item.file}|${item.line}|${item.message}`;
    if (seen.has(key) || list.length >= MAX_ITEMS) return;
    seen.add(key);
    list.push(item);
  };

  /** Read TeX's `l.<n> <context>` lines following an error. */
  const readContext = (start: number): { line?: number; context?: string } => {
    for (let j = start; j < Math.min(lines.length, start + 12); j++) {
      const m = /^l\.(\d+)\s?(.*)$/.exec(lines[j]);
      if (m) {
        const next = lines[j + 1]?.trim();
        const context = [m[2].trim(), next && !/^\s*$/.test(next) && !next.startsWith("?") ? next : ""]
          .filter(Boolean)
          .join(" ");
        const clipped = context.length > MAX_CONTEXT ? `${context.slice(0, MAX_CONTEXT)}…` : context;
        return { line: Number(m[1]), context: clipped || undefined };
      }
    }
    return {};
  };

  const fileLineError = /^(.*?\.(?:tex|sty|cls|bbl|aux|ltx|def|cfg|clo)):(\d+):\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fle = fileLineError.exec(line);
    if (fle) {
      const message = fle[3].replace(/^LaTeX Error:\s*/, "").trim();
      const { context } = readContext(i + 1);
      const { hint, pkg } = hintFor(message);
      if (pkg) missingPackages.add(pkg);
      push(errors, {
        severity: "error",
        file: toProjectPath(fle[1], mainDir),
        line: Number(fle[2]),
        message,
        context,
        hint,
      });
      continue;
    }

    if (line.startsWith("! ")) {
      const message = line.slice(2).replace(/^LaTeX Error:\s*/, "").trim();
      const { line: errLine, context } = readContext(i + 1);
      const { hint, pkg } = hintFor(message);
      if (pkg) missingPackages.add(pkg);
      push(errors, { severity: "error", message, line: errLine, context, hint });
      continue;
    }

    const refWarning =
      /(?:LaTeX|Package \w+) Warning: (Citation|Reference) [`'"]([^'"]+)['"] (?:on page \S+ )?undefined(?: on input line (\d+))?/.exec(
        line,
      );
    if (refWarning) {
      push(warnings, {
        severity: "warning",
        message: t(refWarning[1] === "Citation" ? "log.undefinedCitation" : "log.undefinedReference", { key: refWarning[2] }),
        line: refWarning[3] ? Number(refWarning[3]) : undefined,
      });
      continue;
    }

    const genericWarning = /^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(line);
    if (genericWarning) {
      let message = genericWarning[3];
      // Package warnings continue on lines starting with "(pkg)".
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s/.test(lines[j]); j++) {
        message += ` ${lines[j].replace(/^\(\S+\)\s+/, "")}`;
      }
      const inputLine = /on input line (\d+)/.exec(message);
      if (/There were undefined references|Label\(s\) may have changed|Rerun to get/.test(message)) continue;
      push(warnings, {
        severity: "warning",
        message: message.replace(/\s+on input line \d+\.?/, "").trim(),
        line: inputLine ? Number(inputLine[1]) : undefined,
      });
    }
  }

  if (errors.length === 0 && /Fatal error occurred, no output PDF file produced/.test(log)) {
    errors.push({ severity: "error", message: t("log.fatal") });
  }
  if (errors.length === 0 && /Emergency stop/.test(log)) {
    errors.push({ severity: "error", message: t("log.emergency") });
  }
  return { errors, warnings, missingPackages: [...missingPackages] };
}
