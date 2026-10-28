/**
 * Multi-file editor session.
 *
 * One CodeMirror view is reused for every open file; each file keeps its own
 * EditorState (and therefore its own undo history, selection and scroll).
 */
import { Compartment, EditorSelection, EditorState, type Extension, type StateEffect, Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { flashLine } from "./aiTarget";
import { editorTheme, fontTheme } from "./theme";

export interface EditorConfig {
  dark: boolean;
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
}

export interface SessionListener {
  onDocChanged(path: string): void;
  onSelectionChanged(path: string, state: EditorState): void;
  onDirtyChanged(path: string, dirty: boolean): void;
  onActivated(path: string): void;
}

export interface SelectionSnapshot {
  path: string;
  from: number;
  to: number;
  text: string;
  docText: string;
}

const compartments = {
  theme: new Compartment(),
  font: new Compartment(),
  tab: new Compartment(),
  wrap: new Compartment(),
};

/** Per file, not part of the shared config: a file that is not UTF-8 stays read-only until it is converted. */
const lock = new Compartment();
const lockExtension = (readOnly: boolean): Extension => (readOnly ? EditorState.readOnly.of(true) : []);

class EditorSession {
  private view: EditorView | null = null;
  private readonly states = new Map<string, EditorState>();
  private readonly saved = new Map<string, Text>();
  private readonly dirty = new Map<string, boolean>();
  private baseExtensions: Extension[] = [];
  private config: EditorConfig = {
    dark: false,
    fontFamily: "monospace",
    fontSize: 14,
    tabSize: 2,
    wordWrap: true,
  };
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  activePath: string | null = null;
  listener: SessionListener | null = null;

  /** Extensions shared by every file (set once by the editor component). */
  setBaseExtensions(extensions: Extension[]) {
    this.baseExtensions = [...extensions, EditorView.updateListener.of((u) => this.handleUpdate(u))];
  }

  private configExtensions(): Extension[] {
    const c = this.config;
    return [
      compartments.theme.of(editorTheme(c.dark)),
      compartments.font.of(fontTheme(c.fontFamily, c.fontSize)),
      compartments.tab.of([EditorState.tabSize.of(c.tabSize), indentUnit.of(" ".repeat(c.tabSize))]),
      compartments.wrap.of(c.wordWrap ? EditorView.lineWrapping : []),
    ];
  }

  private reconfigureEffects() {
    const c = this.config;
    return [
      compartments.theme.reconfigure(editorTheme(c.dark)),
      compartments.font.reconfigure(fontTheme(c.fontFamily, c.fontSize)),
      compartments.tab.reconfigure([EditorState.tabSize.of(c.tabSize), indentUnit.of(" ".repeat(c.tabSize))]),
      compartments.wrap.reconfigure(c.wordWrap ? EditorView.lineWrapping : []),
    ];
  }

  setConfig(config: EditorConfig) {
    this.config = config;
    this.view?.dispatch({ effects: this.reconfigureEffects() });
  }

  attach(view: EditorView) {
    this.view = view;
    if (this.activePath && this.states.has(this.activePath)) {
      view.setState(this.states.get(this.activePath)!);
      view.dispatch({ effects: this.reconfigureEffects() });
    }
  }

  detach() {
    if (this.view && this.activePath) this.states.set(this.activePath, this.view.state);
    this.view = null;
  }

  getView(): EditorView | null {
    return this.view;
  }

  has(path: string): boolean {
    return this.states.has(path);
  }

  /** Create the editor state for a file (no-op if already open). */
  open(path: string, text: string, cursor?: { anchor: number; head: number }, options: { readOnly?: boolean } = {}) {
    if (this.states.has(path)) return;
    const len = text.length;
    const selection = cursor
      ? EditorSelection.single(Math.min(cursor.anchor, len), Math.min(cursor.head, len))
      : EditorSelection.cursor(0);
    const state = EditorState.create({
      doc: text,
      selection,
      extensions: [...this.baseExtensions, ...this.configExtensions(), lock.of(lockExtension(options.readOnly ?? false))],
    });
    this.states.set(path, state);
    this.saved.set(path, state.doc);
    this.dirty.set(path, false);
  }

  activate(path: string) {
    if (!this.states.has(path)) return;
    // The live state of the active file is the view's state; the map entry is
    // only updated when switching away. Never restore it for the active file.
    const switching = path !== this.activePath;
    if (this.view && this.activePath && switching) {
      this.states.set(this.activePath, this.view.state);
    }
    this.activePath = path;
    const state = this.states.get(path)!;
    if (this.view && switching && this.view.state !== state) {
      this.view.setState(state);
      this.view.dispatch({ effects: this.reconfigureEffects() });
      this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: "center" }) });
    }
    this.listener?.onActivated(path);
    this.listener?.onSelectionChanged(path, this.stateOf(path)!);
  }

  close(path: string) {
    this.states.delete(path);
    this.saved.delete(path);
    this.dirty.delete(path);
    if (this.activePath === path) this.activePath = null;
  }

  stateOf(path: string): EditorState | undefined {
    if (path === this.activePath && this.view) return this.view.state;
    return this.states.get(path);
  }

  textOf(path: string): string | undefined {
    return this.stateOf(path)?.doc.toString();
  }

  openPaths(): string[] {
    return [...this.states.keys()];
  }

  isDirty(path: string): boolean {
    return this.dirty.get(path) ?? false;
  }

  isReadOnly(path: string): boolean {
    return this.stateOf(path)?.readOnly ?? false;
  }

  /** Lock or unlock a file for editing; programmatic reloads still replace its text. */
  setReadOnly(path: string, readOnly: boolean) {
    if (this.has(path) && this.isReadOnly(path) !== readOnly) this.dispatchEffects(path, [lock.reconfigure(lockExtension(readOnly))]);
  }

  /** Record that `text` (default: current content) is what is on disk. */
  markSaved(path: string, text?: string) {
    const state = this.stateOf(path);
    if (!state) return;
    this.saved.set(path, text === undefined ? state.doc : Text.of(text.split(/\r\n|\r|\n/)));
    this.updateDirty(path, state.doc);
  }

  /** Replace a file's content (external reload). Kept undoable. */
  replaceDocument(path: string, text: string) {
    const state = this.stateOf(path);
    if (!state) return;
    const spec = { changes: { from: 0, to: state.doc.length, insert: text } };
    if (path === this.activePath && this.view) this.view.dispatch(spec);
    else this.states.set(path, state.update(spec).state);
    this.markSaved(path);
  }

  /** Dispatch state effects to any open file (active or in the background). */
  dispatchEffects(path: string, effects: StateEffect<unknown>[]) {
    if (path === this.activePath && this.view) this.view.dispatch({ effects });
    else {
      const state = this.states.get(path);
      if (state) this.states.set(path, state.update({ effects }).state);
    }
  }

  /** Apply an edit to any open file that is not read-only. */
  applyEdit(path: string, from: number, to: number, insert: string, effects: StateEffect<unknown>[] = []) {
    const state = this.stateOf(path);
    if (!state || state.readOnly) return false;
    const spec = {
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      effects,
      userEvent: "input.ai",
    };
    if (path === this.activePath && this.view) {
      this.view.dispatch(spec);
    } else {
      this.states.set(path, state.update(spec).state);
      this.updateDirty(path, this.states.get(path)!.doc);
      this.listener?.onDocChanged(path);
    }
    return true;
  }

  selection(): SelectionSnapshot | null {
    if (!this.view || !this.activePath) return null;
    const { state } = this.view;
    const main = state.selection.main;
    return {
      path: this.activePath,
      from: main.from,
      to: main.to,
      text: state.sliceDoc(main.from, main.to),
      docText: state.doc.toString(),
    };
  }

  /** Move the cursor to a 1-based line (and column) of the active file. */
  goto(line: number, column = 0, focus = true) {
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(target.from + column, target.to);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: [EditorView.scrollIntoView(pos, { y: "start", yMargin: 60 }), flashLine.of(pos)],
    });
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.view?.dispatch({ effects: flashLine.of(null) }), 1200);
    if (focus) view.focus();
  }

  focus() {
    this.view?.focus();
  }

  private updateDirty(path: string, doc: Text) {
    const saved = this.saved.get(path);
    const isDirty = saved ? !doc.eq(saved) : true;
    if (this.dirty.get(path) !== isDirty) {
      this.dirty.set(path, isDirty);
      this.listener?.onDirtyChanged(path, isDirty);
    }
  }

  private handleUpdate(update: ViewUpdate) {
    const path = this.activePath;
    if (!path || update.view !== this.view) return;
    if (update.docChanged) {
      this.updateDirty(path, update.state.doc);
      this.listener?.onDocChanged(path);
    }
    if (update.selectionSet || update.docChanged) this.listener?.onSelectionChanged(path, update.state);
  }
}

export const editorSession = new EditorSession();
