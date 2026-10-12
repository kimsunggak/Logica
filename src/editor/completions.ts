/**
 * LaTeX autocomplete: common commands, environments, BibTeX keys inside
 * \cite{...} and labels inside \ref{...} / \eqref{...}.
 */
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { formatAuthors, type BibEntry } from "../latex/bibtex/bibParser";
import type { LabelDef } from "../latex/parser/documentModel";
import { CITE_COMMAND_PATTERN, REF_COMMANDS } from "../latex/parser/parseFile";

export interface CompletionData {
  bibEntries: BibEntry[];
  labels: LabelDef[];
}

const COMMANDS: Completion[] = [
  snippetCompletion("\\section{${title}}", { label: "\\section", type: "keyword", detail: "heading" }),
  snippetCompletion("\\subsection{${title}}", { label: "\\subsection", type: "keyword", detail: "heading" }),
  snippetCompletion("\\subsubsection{${title}}", { label: "\\subsubsection", type: "keyword", detail: "heading" }),
  snippetCompletion("\\paragraph{${title}}", { label: "\\paragraph", type: "keyword" }),
  snippetCompletion("\\cite{${key}}", { label: "\\cite", type: "function", detail: "citation" }),
  snippetCompletion("\\citep{${key}}", { label: "\\citep", type: "function", detail: "citation" }),
  snippetCompletion("\\citet{${key}}", { label: "\\citet", type: "function", detail: "citation" }),
  snippetCompletion("\\ref{${label}}", { label: "\\ref", type: "function", detail: "reference" }),
  snippetCompletion("\\eqref{${label}}", { label: "\\eqref", type: "function", detail: "reference" }),
  snippetCompletion("\\autoref{${label}}", { label: "\\autoref", type: "function", detail: "reference" }),
  snippetCompletion("\\cref{${label}}", { label: "\\cref", type: "function", detail: "reference" }),
  snippetCompletion("\\label{${key}}", { label: "\\label", type: "function" }),
  snippetCompletion("\\emph{${text}}", { label: "\\emph", type: "function" }),
  snippetCompletion("\\textbf{${text}}", { label: "\\textbf", type: "function" }),
  snippetCompletion("\\textit{${text}}", { label: "\\textit", type: "function" }),
  snippetCompletion("\\footnote{${text}}", { label: "\\footnote", type: "function" }),
  snippetCompletion("\\input{${file}}", { label: "\\input", type: "function" }),
  snippetCompletion("\\include{${file}}", { label: "\\include", type: "function" }),
  snippetCompletion("\\includegraphics[width=\\linewidth]{${file}}", { label: "\\includegraphics", type: "function" }),
  snippetCompletion("\\begin{${env}}\n\t${}\n\\end{${env}}", { label: "\\begin", type: "keyword", detail: "environment" }),
  snippetCompletion("\\begin{figure}[t]\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{${file}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n\\end{figure}", {
    label: "\\begin{figure}",
    type: "keyword",
    detail: "environment",
  }),
  snippetCompletion("\\begin{equation}\n\t${}\n\t\\label{eq:${label}}\n\\end{equation}", {
    label: "\\begin{equation}",
    type: "keyword",
    detail: "environment",
  }),
  snippetCompletion("\\begin{itemize}\n\t\\item ${}\n\\end{itemize}", { label: "\\begin{itemize}", type: "keyword", detail: "environment" }),
  snippetCompletion("\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}", { label: "\\begin{enumerate}", type: "keyword", detail: "environment" }),
];

const ENVIRONMENTS = [
  "figure", "figure*", "table", "table*", "equation", "equation*", "align", "align*", "itemize", "enumerate",
  "description", "abstract", "tabular", "center", "minipage", "theorem", "lemma", "proof", "algorithm", "verbatim",
];

function citeOptions(entries: BibEntry[]): Completion[] {
  return entries.map((entry) => {
    const authors = formatAuthors(entry.author);
    return {
      label: entry.key,
      type: "text",
      detail: [authors, entry.year].filter(Boolean).join(" "),
      info: () => {
        const el = document.createElement("div");
        el.className = "cm-cite-info";
        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.textContent = entry.title ?? entry.key;
        const meta = document.createElement("div");
        meta.style.opacity = "0.75";
        meta.textContent = [authors, entry.year, entry.venue].filter(Boolean).join(", ");
        el.append(title, meta);
        return el;
      },
    } satisfies Completion;
  });
}

function closeBrace(context: CompletionContext, to: number): string {
  return context.state.sliceDoc(to, to + 1) === "}" ? "" : "}";
}

export function latexCompletionSource(getData: () => CompletionData) {
  const citeRe = new RegExp(`\\\\(?:${CITE_COMMAND_PATTERN})\\*?(?:\\[[^\\]]*\\])*\\{([^}]*)$`);
  const refRe = new RegExp(`\\\\(?:${REF_COMMANDS.join("|")})\\{([^}]*)$`);

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);

    const cite = citeRe.exec(before);
    if (cite) {
      const typed = cite[1];
      const keyStart = context.pos - (typed.length - typed.lastIndexOf(",") - 1);
      const options = citeOptions(getData().bibEntries).map((o) => ({
        ...o,
        apply: (view: EditorView, completion: Completion, from: number, to: number) => {
          const insert = completion.label + closeBrace(context, to);
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + completion.label.length + (insert.endsWith("}") ? 1 : 0) } });
        },
      }));
      return { from: keyStart, options, validFor: /^[^,}\s]*$/ };
    }

    const ref = refRe.exec(before);
    if (ref) {
      const labels = getData().labels;
      const seen = new Set<string>();
      const options: Completion[] = [];
      for (const l of labels) {
        if (seen.has(l.key)) continue;
        seen.add(l.key);
        options.push({ label: l.key, type: "variable", detail: `${l.filePath}:${l.line}` });
      }
      return { from: context.pos - ref[1].length, options, validFor: /^[^}\s]*$/ };
    }

    const env = /\\(?:begin|end)\{([a-zA-Z*]*)$/.exec(before);
    if (env) {
      return {
        from: context.pos - env[1].length,
        options: ENVIRONMENTS.map((name) => ({ label: name, type: "type" })),
        validFor: /^[a-zA-Z*]*$/,
      };
    }

    const command = context.matchBefore(/\\[a-zA-Z]*/);
    if (command && (command.from < command.to || context.explicit)) {
      return { from: command.from, options: COMMANDS, validFor: /^\\[a-zA-Z{]*$/ };
    }
    return null;
  };
}
