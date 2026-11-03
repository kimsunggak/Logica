/**
 * Editor extensions and keyboard shortcuts shared by every open file.
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { keyAtOffset, REF_COMMANDS } from "../latex/parser/parseFile";
import { compileProject, gotoDefinition, saveActive, saveAll } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { aiTargetField, flashLineField } from "./aiTarget";
import { latexCompletionSource } from "./completions";
import { editorSession } from "./editorSession";
import { acceptInlineEdit, openInlineEdit, rejectInlineEdit, useInlineEdit } from "./inlineEdit/inlineEditStore";
import { latexLanguage } from "./latexLanguage";

function isNavigable(command: string): boolean {
  return REF_COMMANDS.includes(command) || /cite/i.test(command) || command === "input" || command === "include";
}

const appKeymap = keymap.of([
  { key: "Mod-s", run: () => (void saveActive(), true), preventDefault: true },
  { key: "Mod-Shift-s", run: () => (void saveAll(), true), preventDefault: true },
  {
    // Accept a reviewed AI edit, otherwise compile.
    key: "Mod-Enter",
    run: () => {
      const inline = useInlineEdit.getState();
      if (inline.open && inline.phase === "review") acceptInlineEdit();
      else void compileProject();
      return true;
    },
    preventDefault: true,
  },
  { key: "Mod-k", run: () => openInlineEdit(), preventDefault: true },
  {
    key: "F12",
    run: (view) => {
      const path = editorSession.activePath;
      if (path) void gotoDefinition(path, view.state.selection.main.head);
      return true;
    },
  },
  {
    key: "Escape",
    run: () => {
      if (!useInlineEdit.getState().open) return false;
      rejectInlineEdit();
      return true;
    },
  },
]);

/** Cmd/Ctrl+click on \ref, \cite or \input jumps to the target. */
const clickNavigation = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const path = editorSession.activePath;
    if (pos == null || !path) return false;
    const line = view.state.doc.lineAt(pos);
    const hit = keyAtOffset(line.text, pos - line.from);
    if (!hit || !isNavigable(hit.command)) return false;
    event.preventDefault();
    void gotoDefinition(path, pos);
    return true;
  },
});

export function createBaseExtensions(): Extension[] {
  return [
    Prec.highest(appKeymap),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({
      override: [
        latexCompletionSource(() => ({
          bibEntries: useProject.getState().bibEntries,
          labels: useProject.getState().doc?.labels ?? [],
        })),
      ],
      icons: false,
    }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    latexLanguage,
    aiTargetField,
    flashLineField,
    clickNavigation,
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
  ];
}

let installed = false;

/** Must run before any file is opened. */
export function installEditorExtensions() {
  if (installed) return;
  installed = true;
  editorSession.setBaseExtensions(createBaseExtensions());
}
