/** Literal title/author declarations, with exact source ranges and a code-generated description. */
import type { SourceRange } from "../../ai/types";
import { giOf, type PaperDocument } from "../../latex/parser/documentModel";
import { computeLineStarts, findCommands, latexToPlain, lineOfOffset, maskComments } from "../../latex/parser/text";

export const METADATA = "metadata";

export function paperMetadata(doc: PaperDocument, files: Map<string, string>): { sources: SourceRange[]; summary: string } | null {
  const parsed = new Map<string, { source: SourceRange; value: string; name: string; offset: number }[]>();
  const sources: SourceRange[] = [];
  const titles: string[] = [], authors: string[] = [];
  const endLine = doc.mainFile && doc.facts.get(doc.mainFile)?.endDocumentLine;
  const end = endLine && doc.mainFile ? giOf(doc, doc.mainFile, endLine) : -1;
  const endOffset = doc.mainFile ? findCommands(maskComments(files.get(doc.mainFile) ?? ""), ["end"]).find((command) => command.arg?.trim() === "document")?.start : undefined;
  // Spans follow include order and exclude files outside the paper.
  for (const span of doc.spans) {
    let declarations = parsed.get(span.filePath);
    if (!declarations) {
      const text = files.get(span.filePath) ?? "";
      const masked = maskComments(text);
      const starts = computeLineStarts(text);
      declarations = [];
      let cursor = 0, depth = 0;
      for (const command of findCommands(masked, ["title", "author"])) {
        // A declaration inside a macro definition is not a literal paper field.
        while (cursor < command.start) {
          const char = masked[cursor++];
          if (char === "\\") cursor++;
          else if (char === "{") depth++;
          else if (char === "}") depth--;
        }
        if (depth !== 0 || command.arg === null) continue;
        declarations.push({
          source: { path: span.filePath, fromLine: lineOfOffset(starts, command.start), toLine: lineOfOffset(starts, command.end - 1), text: text.slice(command.start, command.end) },
          value: latexToPlain(command.arg) || command.arg.trim() || "(empty)", name: command.name, offset: command.start,
        });
      }
      parsed.set(span.filePath, declarations);
    }
    for (const declaration of declarations) {
      if (declaration.source.fromLine < span.fromLine || declaration.source.fromLine > span.toLine) continue;
      const position = span.giStart + declaration.source.fromLine - span.fromLine;
      if (end >= 0 && (position > end || position === end && (span.filePath !== doc.mainFile || endOffset === undefined || declaration.offset >= endOffset))) continue;
      sources.push(declaration.source);
      (declaration.name === "title" ? titles : authors).push(declaration.value);
    }
  }
  if (!sources.length) return null;
  const summary = [titles.length ? `Title: ${titles.join("; ")}` : "", authors.length ? `Authors: ${authors.join("; ")}` : ""].filter(Boolean).join("\n");
  return { sources, summary };
}
