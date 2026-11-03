import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";

/** LaTeX syntax highlighting (CodeMirror legacy stex mode). */
export const latexLanguage = StreamLanguage.define({
  ...stex,
  languageData: {
    commentTokens: { line: "%" },
    // Quotes are not paired: LaTeX uses ``...'' and apostrophes are common.
    closeBrackets: { brackets: ["(", "[", "{"] },
  },
});
