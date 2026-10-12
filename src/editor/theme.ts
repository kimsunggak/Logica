import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#7c3aed" },
  { tag: [t.tagName, t.atom], color: "#0369a1" },
  { tag: t.bracket, color: "#64748b" },
  { tag: t.comment, color: "#64748b", fontStyle: "italic" },
  { tag: t.string, color: "#047857" },
  { tag: t.number, color: "#b45309" },
  { tag: [t.variableName, t.special(t.variableName)], color: "#be185d" },
  { tag: t.heading, fontWeight: "bold" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c4b5fd" },
  { tag: [t.tagName, t.atom], color: "#7dd3fc" },
  { tag: t.bracket, color: "#94a3b8" },
  { tag: t.comment, color: "#7d8799", fontStyle: "italic" },
  { tag: t.string, color: "#6ee7b7" },
  { tag: t.number, color: "#fcd34d" },
  { tag: [t.variableName, t.special(t.variableName)], color: "#f9a8d4" },
  { tag: t.heading, fontWeight: "bold" },
]);

function baseTheme(dark: boolean) {
  return EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: dark ? "#0f141b" : "#ffffff", color: dark ? "#d7dde6" : "#1e293b" },
      ".cm-content": { caretColor: dark ? "#e2e8f0" : "#0f172a", paddingBottom: "40vh" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: dark ? "#e2e8f0" : "#0f172a" },
      ".cm-gutters": {
        backgroundColor: dark ? "#0f141b" : "#ffffff",
        color: dark ? "#55606e" : "#94a3b8",
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: dark ? "#161d27" : "#f6f8fb" },
      ".cm-activeLineGutter": { backgroundColor: dark ? "#161d27" : "#f1f5f9", color: dark ? "#cbd5e1" : "#475569" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "#264f78 !important" : "#cfe3ff !important",
      },
      ".cm-searchMatch": { backgroundColor: dark ? "#5b4b16" : "#fde68a" },
      ".cm-panels": { backgroundColor: dark ? "#161d27" : "#f8fafc", color: "inherit" },
      ".cm-tooltip": { backgroundColor: dark ? "#1b2330" : "#ffffff", border: `1px solid ${dark ? "#2b3646" : "#e2e8f0"}` },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: dark ? "#264f78" : "#dbeafe", color: "inherit" },
      ".cm-ai-target": { backgroundColor: dark ? "rgba(56,189,248,0.18)" : "rgba(14,165,233,0.15)", borderRadius: "2px" },
      ".cm-flash-line": { backgroundColor: dark ? "rgba(250,204,21,0.18)" : "rgba(250,204,21,0.30)" },
    },
    { dark },
  );
}

export function editorTheme(dark: boolean): Extension {
  return [baseTheme(dark), syntaxHighlighting(dark ? darkHighlight : lightHighlight)];
}

export function fontTheme(fontFamily: string, fontSize: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-scroller": { fontFamily, lineHeight: "1.55" },
  });
}
