/**
 * Minimal safety checks for AI rewrites before they are applied.
 *
 * The checks compare the rewrite with the original selection so that
 * pre-existing oddities (a selection that starts mid-group) are not flagged.
 * "error" issues mean the result would very likely break compilation or
 * cross references; "warning" issues are things the author should look at.
 */
import { CITE_COMMAND_PATTERN, REF_COMMANDS } from "./parser/parseFile";
import { commentStart } from "./parser/text";
import { t } from "../i18n";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const idx = commentStart(line);
      return idx < 0 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function isEscaped(text: string, index: number): boolean {
  let n = 0;
  for (let j = index - 1; j >= 0 && text[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

function braceBalance(text: string): number {
  let balance = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "{" || ch === "}") && !isEscaped(text, i)) balance += ch === "{" ? 1 : -1;
  }
  return balance;
}

function dollarCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && !isEscaped(text, i)) count++;
  }
  return count;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function environmentBalance(text: string): Map<string, number> {
  const balance = new Map<string, number>();
  for (const m of text.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    const name = m[2].trim();
    balance.set(name, (balance.get(name) ?? 0) + (m[1] === "begin" ? 1 : -1));
  }
  return balance;
}

function keysOf(text: string, commands: string): Set<string> {
  const keys = new Set<string>();
  const pattern = new RegExp(`\\\\(?:${commands})\\*?\\s*(?:\\[[^\\]]*\\]\\s*){0,2}\\{([^}]*)\\}`, "g");
  for (const m of text.matchAll(pattern)) {
    for (const key of m[1].split(",")) if (key.trim()) keys.add(key.trim());
  }
  return keys;
}

function mathSegments(text: string): string[] {
  const segments: string[] = [];
  const pattern = /\$\$[\s\S]+?\$\$|(?<!\\)\$[^$]+?(?<!\\)\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\\begin\{(equation|align|gather|multline|eqnarray)\*?\}[\s\S]+?\\end\{\1\*?\}/g;
  for (const m of text.matchAll(pattern)) segments.push(m[0].replace(/\s+/g, " ").trim());
  return segments;
}

function commandsUsed(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\\([a-zA-Z@]+)/g)) names.add(m[1]);
  return names;
}

function commentCount(text: string): number {
  return text.split("\n").filter((line) => commentStart(line) >= 0).length;
}

const diffList = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

export interface ValidationOptions {
  /** Known BibTeX keys; unknown new citation keys are reported. */
  bibKeys?: Set<string>;
}

export function validateRewrite(
  original: string,
  rewritten: string,
  options: ValidationOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!rewritten.trim()) {
    return [{ severity: "error", message: t("val.empty") }];
  }
  const o = stripComments(original);
  const r = stripComments(rewritten);

  if (braceBalance(o) !== braceBalance(r)) {
    issues.push({ severity: "error", message: t("val.braces") });
  }
  const envO = environmentBalance(o);
  const envR = environmentBalance(r);
  for (const name of new Set([...envO.keys(), ...envR.keys()])) {
    if ((envO.get(name) ?? 0) !== (envR.get(name) ?? 0)) {
      issues.push({ severity: "error", message: t("val.environment", { name }) });
    }
  }
  if (dollarCount(o) % 2 !== dollarCount(r) % 2) {
    issues.push({ severity: "error", message: t("val.dollar") });
  }
  if (
    countMatches(o, /\\\(/g) - countMatches(o, /\\\)/g) !== countMatches(r, /\\\(/g) - countMatches(r, /\\\)/g) ||
    countMatches(o, /\\\[/g) - countMatches(o, /\\\]/g) !== countMatches(r, /\\\[/g) - countMatches(r, /\\\]/g)
  ) {
    issues.push({ severity: "error", message: t("val.mathDelimiters") });
  }

  const labelsO = keysOf(o, "label");
  const labelsR = keysOf(r, "label");
  const lostLabels = diffList(labelsO, labelsR);
  if (lostLabels.length) {
    issues.push({ severity: "error", message: t("val.labelRemoved", { keys: lostLabels.join(", ") }) });
  }
  const newLabels = diffList(labelsR, labelsO);
  if (newLabels.length) {
    issues.push({ severity: "warning", message: t("val.labelAdded", { keys: newLabels.join(", ") }) });
  }

  const citesO = keysOf(o, CITE_COMMAND_PATTERN);
  const citesR = keysOf(r, CITE_COMMAND_PATTERN);
  const lostCites = diffList(citesO, citesR);
  if (lostCites.length) {
    issues.push({ severity: "warning", message: t("val.citeRemoved", { keys: lostCites.join(", ") }) });
  }
  const newCites = diffList(citesR, citesO);
  const unknown = options.bibKeys ? newCites.filter((k) => !options.bibKeys!.has(k)) : [];
  if (unknown.length) {
    issues.push({ severity: "error", message: t("val.citeUnknown", { keys: unknown.join(", ") }) });
  } else if (newCites.length) {
    issues.push({ severity: "warning", message: t("val.citeAdded", { keys: newCites.join(", ") }) });
  }

  const refsO = keysOf(o, REF_COMMANDS.join("|"));
  const refsR = keysOf(r, REF_COMMANDS.join("|"));
  const lostRefs = diffList(refsO, refsR);
  if (lostRefs.length) {
    issues.push({ severity: "warning", message: t("val.refRemoved", { keys: lostRefs.join(", ") }) });
  }
  const newRefs = diffList(refsR, refsO);
  if (newRefs.length) {
    issues.push({ severity: "warning", message: t("val.refAdded", { keys: newRefs.join(", ") }) });
  }

  const mathO = mathSegments(o);
  const mathR = new Set(mathSegments(r));
  if (mathO.some((seg) => !mathR.has(seg))) {
    issues.push({ severity: "warning", message: t("val.math") });
  }

  const lostCommands = diffList(commandsUsed(o), commandsUsed(r)).filter(
    (c) => !["label", "begin", "end"].includes(c),
  );
  if (lostCommands.length) {
    issues.push({
      severity: "warning",
      message: t("val.commands", { commands: lostCommands.map((c) => `\\${c}`).join(", ") }),
    });
  }

  if (commentCount(rewritten) < commentCount(original)) {
    issues.push({ severity: "warning", message: t("val.comments") });
  }
  return issues;
}

/**
 * Clean a model response so it can replace the selection: remove a wrapping
 * code fence and restore the original's leading/trailing whitespace.
 */
export function normalizeRewrite(original: string, response: string): string {
  let text = response;
  const fence = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fence) text = fence[1];
  const leading = /^\s*/.exec(original)?.[0] ?? "";
  const trailing = /\s*$/.exec(original)?.[0] ?? "";
  return leading + text.trim() + trailing;
}
