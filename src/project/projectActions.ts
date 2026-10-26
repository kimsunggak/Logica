/**
 * Project workflow: open a folder, open/save files, keep the paper model up
 * to date, compile, navigate and react to external file changes.
 */
import type { EditorState } from "@codemirror/state";
import { editorSession } from "../editor/editorSession";
import { parseBibtex, type BibEntry, type BibParseError } from "../latex/bibtex/bibParser";
import { cancelCompileJob, compileLatex } from "../latex/compiler/compileApi";
import { parseLatexLog } from "../latex/compiler/logParser";
import { buildPaperDocument, sectionAt, type PaperSection } from "../latex/parser/documentModel";
import { keyAtOffset, REF_COMMANDS } from "../latex/parser/parseFile";
import { confirmDialog, errorKind, errorMessage } from "../lib/backend";
import { useSettings } from "../settings/settingsStore";
import { useWorkspace } from "../storage/workspaceStore";
import { createStarterProject, exportPdfFile, listProjectFiles, pathExists, readTextFile, statFiles, writeTextFile } from "./projectApi";
import { initialProjectState, notify, openFileMeta, updateOpenFile, useProject, type CompileTrigger } from "./projectStore";
import type { PaperTemplateId } from "./templates";
import { t } from "../i18n";

/** Last known disk content of every .tex/.bib file of the project. */
const diskTexts = new Map<string, string>();
const diskMtimes = new Map<string, number>();

const SOURCE_FILE = /\.(tex|bib|sty|cls)$/i;
const MAX_PRELOADED_FILES = 400;

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Current text of every source file, with unsaved editor buffers on top. */
export function currentTexts(): Map<string, string> {
  const files = new Map(diskTexts);
  for (const path of editorSession.openPaths()) {
    const text = editorSession.textOf(path);
    if (text !== undefined) files.set(path, text);
  }
  return files;
}

function hasUnsavedChanges(): boolean {
  return useProject.getState().openFiles.some((f) => f.dirty);
}

// ---------------------------------------------------------------- project

export async function openProject(root: string): Promise<void> {
  const state = useProject.getState();
  if (state.root && hasUnsavedChanges()) {
    const ok = await confirmDialog(t("project.unsavedOpen"));
    if (!ok) return;
  }
  useProject.setState({ loading: true });
  let listing;
  try {
    listing = await listProjectFiles(root);
  } catch (err) {
    useProject.setState({ loading: false });
    notify("error", t("project.openError", { error: errorMessage(err) }));
    return;
  }

  cancelCompile();
  for (const path of editorSession.openPaths()) editorSession.close(path);
  diskTexts.clear();
  diskMtimes.clear();

  const sources = listing.entries.filter((e) => SOURCE_FILE.test(e.path)).slice(0, MAX_PRELOADED_FILES);
  await Promise.all(
    sources.map(async (entry) => {
      try {
        const file = await readTextFile(listing.root, entry.path);
        diskTexts.set(entry.path, file.content);
        diskMtimes.set(entry.path, file.mtime);
      } catch {
        // Unreadable files are simply skipped; they stay visible in the explorer.
      }
    }),
  );

  const workspace = useWorkspace.getState();
  workspace.setLastProject(listing.root);
  const memory = workspace.project(listing.root);

  useProject.setState({
    ...initialProjectState,
    root: listing.root,
    name: basename(listing.root),
    entries: listing.entries,
    mainFile: memory.mainFile && diskTexts.has(memory.mainFile) ? memory.mainFile : undefined,
    loading: false,
  });
  if (listing.truncated) notify("info", t("project.truncated"));

  rebuildDocumentNow();
  const doc = useProject.getState().doc;
  if (!doc?.mainFile) notify("info", t("project.noMain"));
  else
    void showExistingPdf(listing.root, doc.mainFile).then((found) => {
      // Nothing compiled yet (e.g. a new paper): build the preview right away.
      if (!found && useSettings.getState().latex.livePreview && useProject.getState().root === listing.root) void compileProject("live");
    });

  const toOpen = memory.openFiles.filter((p) => diskTexts.has(p));
  const active = memory.activeFile && diskTexts.has(memory.activeFile) ? memory.activeFile : toOpen[0] ?? doc?.mainFile;
  for (const path of toOpen) await openFile(path, { activate: false });
  if (active) await openFile(active);
}

/** Show the PDF from a previous compilation, if there is one. */
async function showExistingPdf(root: string, mainFile: string): Promise<boolean> {
  const pdfPath = mainFile.replace(/\.tex$/, ".pdf");
  if (!(await pathExists(root, pdfPath).catch(() => false))) return false;
  if (useProject.getState().root === root) {
    useProject.setState((s) => ({ compile: { ...s.compile, pdfPath, pdfVersion: s.compile.pdfVersion + 1 } }));
  }
  return true;
}

/** Leave the project for the home screen. Pending edits are saved first. */
export async function closeProject(): Promise<boolean> {
  if (!useProject.getState().root) return true;
  await saveQuietly();
  if (hasUnsavedChanges() && !(await confirmDialog(t("project.unsavedHome")))) return false;
  cancelCompile();
  clearTimeout(rebuildTimer);
  for (const path of editorSession.openPaths()) editorSession.close(path);
  diskTexts.clear();
  diskMtimes.clear();
  useProject.setState((s) => ({ ...initialProjectState, notices: s.notices }));
  return true;
}

/**
 * Start a paper from a template. With `reuse` the template's existing first
 * folder ("My Paper", "CVPR Paper") is reopened instead of creating another one.
 */
export async function newPaper(template: PaperTemplateId, reuse = false): Promise<void> {
  try {
    await openProject(await createStarterProject(template, reuse));
  } catch (err) {
    notify("error", t("project.newError", { error: errorMessage(err) }));
  }
}

export async function refreshFileList(): Promise<void> {
  const { root } = useProject.getState();
  if (!root) return;
  try {
    const listing = await listProjectFiles(root);
    useProject.setState({ entries: listing.entries });
    const newSources = listing.entries.filter((e) => SOURCE_FILE.test(e.path) && !diskTexts.has(e.path));
    for (const entry of newSources.slice(0, 50)) {
      const file = await readTextFile(root, entry.path).catch(() => null);
      if (file) {
        diskTexts.set(entry.path, file.content);
        diskMtimes.set(entry.path, file.mtime);
      }
    }
    if (newSources.length) scheduleRebuild();
  } catch {
    // Folder temporarily unavailable; keep the current listing.
  }
}

export function setMainFile(path: string) {
  const { root } = useProject.getState();
  if (!root) return;
  useProject.setState({ mainFile: path });
  useWorkspace.getState().updateProject(root, { mainFile: path });
  rebuildDocumentNow();
}

// ---------------------------------------------------------------- files

function rememberOpenFiles() {
  const { root, openFiles, activePath } = useProject.getState();
  if (!root) return;
  useWorkspace.getState().updateProject(root, {
    openFiles: openFiles.map((f) => f.path),
    activeFile: activePath ?? undefined,
  });
}

export async function openFile(
  path: string,
  options: { line?: number; column?: number; activate?: boolean; focus?: boolean } = {},
): Promise<boolean> {
  const { root } = useProject.getState();
  if (!root) return false;
  if (!editorSession.has(path)) {
    let content: string;
    let mtime: number;
    let lossy = false;
    try {
      const file = await readTextFile(root, path);
      if (useProject.getState().root !== root) return false;
      content = file.content;
      mtime = file.mtime;
      lossy = file.lossy;
    } catch (err) {
      notify("error", t("project.fileOpenError", { path, error: errorMessage(err) }));
      return false;
    }
    if (SOURCE_FILE.test(path)) {
      diskTexts.set(path, content);
      diskMtimes.set(path, mtime);
    }
    const cursor = useWorkspace.getState().project(root).cursors[path];
    editorSession.open(path, content, cursor);
    useProject.setState((s) => ({
      openFiles: s.openFiles.some((f) => f.path === path)
        ? s.openFiles
        : [...s.openFiles, { path, mtime, dirty: false, lossy }],
    }));
    if (lossy) notify("info", t("project.lossy", { path }));
  }
  if (options.activate !== false) {
    editorSession.activate(path);
    useProject.setState({ activePath: path });
    if (options.line) editorSession.goto(options.line, options.column ?? 0, options.focus !== false);
    else if (options.focus !== false) editorSession.focus();
  }
  rememberOpenFiles();
  return true;
}

export async function closeFile(path: string): Promise<void> {
  const meta = openFileMeta(path);
  if (meta?.dirty) {
    const ok = await confirmDialog(t("project.unsavedClose", { path }));
    if (!ok) return;
  }
  const { openFiles, activePath } = useProject.getState();
  const index = openFiles.findIndex((f) => f.path === path);
  const remaining = openFiles.filter((f) => f.path !== path);
  editorSession.close(path);
  useProject.setState({ openFiles: remaining });
  if (activePath === path) {
    const next = remaining[Math.min(index, remaining.length - 1)];
    if (next) await openFile(next.path);
    else useProject.setState({ activePath: null });
  }
  rememberOpenFiles();
  scheduleRebuild();
}

export async function saveFile(path: string, force = false): Promise<boolean> {
  const { root } = useProject.getState();
  const meta = openFileMeta(path);
  const content = editorSession.textOf(path);
  if (!root || !meta || content === undefined) return false;
  try {
    const expected = meta.external === "deleted" ? undefined : meta.mtime;
    const result = await writeTextFile(root, path, content, expected, force);
    editorSession.markSaved(path, content);
    diskTexts.set(path, content);
    diskMtimes.set(path, result.mtime);
    updateOpenFile(path, { mtime: result.mtime, external: undefined, dirty: editorSession.isDirty(path) });
    return true;
  } catch (err) {
    if (errorKind(err) === "conflict") {
      const ok = await confirmDialog(t("project.overwrite", { path }));
      return ok ? saveFile(path, true) : false;
    }
    notify("error", t("project.saveError", { path, error: errorMessage(err) }));
    return false;
  }
}

export async function saveActive(): Promise<void> {
  const { activePath } = useProject.getState();
  if (!activePath) return;
  const saved = await saveFile(activePath);
  if (saved && useSettings.getState().latex.livePreview) void compileProject("live");
}

export async function saveAll(): Promise<boolean> {
  const dirty = useProject.getState().openFiles.filter((f) => f.dirty || f.external === "deleted");
  let ok = true;
  for (const f of dirty) ok = (await saveFile(f.path)) && ok;
  return ok;
}

// ---------------------------------------------------------------- paper model

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleRebuild(delay = 350) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildDocumentNow, delay);
}

export function rebuildDocumentNow() {
  clearTimeout(rebuildTimer);
  const { root, mainFile } = useProject.getState();
  if (!root) return;
  const texts = currentTexts();
  const tex = new Map([...texts].filter(([p]) => p.endsWith(".tex")));
  const doc = buildPaperDocument({ mainFile, files: tex });

  const bibPaths = doc.bibFiles.filter((p) => texts.has(p));
  const sources = bibPaths.length ? bibPaths : [...texts.keys()].filter((p) => p.endsWith(".bib"));
  const bibEntries: BibEntry[] = [];
  const bibErrors: BibParseError[] = [];
  for (const path of sources) {
    const result = parseBibtex(texts.get(path) ?? "", path);
    bibEntries.push(...result.entries);
    bibErrors.push(...result.errors);
  }
  for (const missing of doc.bibFiles.filter((p) => !texts.has(p))) {
    doc.issues.push({ severity: "warning", message: t("issue.bibMissing", { path: missing }) });
  }
  for (const error of bibErrors.slice(0, 20)) {
    doc.issues.push({ severity: "warning", message: t("issue.bibtex", { message: error.message }), filePath: error.filePath, line: error.line });
  }
  useProject.setState({ doc, bibEntries, bibErrors, mainFile: mainFile ?? doc.mainFile });
  const workspace = useWorkspace.getState();
  if (doc.title !== undefined && workspace.projects[root] && workspace.projects[root].title !== doc.title) {
    workspace.updateProject(root, { title: doc.title });
  }
  const { activePath } = useProject.getState();
  const state = activePath ? editorSession.stateOf(activePath) : undefined;
  if (activePath && state) updateCursor(activePath, state);
}

// ---------------------------------------------------------------- cursor

let cursorMemoryTimer: ReturnType<typeof setTimeout> | undefined;

export function updateCursor(path: string, state: EditorState) {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const { doc, root } = useProject.getState();
  const section = doc ? sectionAt(doc, path, line.number) : null;
  useProject.setState({
    cursor: { line: line.number, column: main.head - line.from + 1, selectionLength: main.to - main.from },
    currentSectionId: section && section.order >= 0 ? section.id : null,
  });
  clearTimeout(cursorMemoryTimer);
  cursorMemoryTimer = setTimeout(() => {
    if (root) useWorkspace.getState().setCursor(root, path, { anchor: main.anchor, head: main.head });
  }, 500);
}

// ---------------------------------------------------------------- navigation

/** Expand the editor panel if it is collapsed (explicit navigation targets it). */
export function revealEditor() {
  if (!useWorkspace.getState().layout.showEditor) useWorkspace.getState().updateLayout({ showEditor: true });
}

export async function navigateTo(path: string, line: number, column = 0): Promise<void> {
  revealEditor();
  await openFile(path, { line, column });
}

export async function navigateToSection(section: PaperSection): Promise<void> {
  await navigateTo(section.filePath, section.startLine);
}

/** Jump from \ref / \eqref / \cite / \input under the cursor to its target. */
export async function gotoDefinition(path: string, offset: number): Promise<boolean> {
  const text = editorSession.textOf(path);
  const { doc, bibEntries } = useProject.getState();
  if (!text || !doc) return false;
  const hit = keyAtOffset(text, offset);
  if (!hit || !hit.key) return false;
  if (REF_COMMANDS.includes(hit.command)) {
    const label = doc.labels.find((l) => l.key === hit.key);
    if (!label) {
      notify("info", t("nav.labelMissing", { key: hit.key }));
      return true;
    }
    await navigateTo(label.filePath, label.line);
    return true;
  }
  if (/cite/i.test(hit.command)) {
    const entry = bibEntries.find((e) => e.key === hit.key);
    if (!entry) {
      notify("info", t("nav.citeMissing", { key: hit.key }));
      return true;
    }
    await navigateTo(entry.filePath, entry.line);
    return true;
  }
  if (hit.command === "input" || hit.command === "include") {
    const target = doc.files.find((f) => f.parent === path && f.path.replace(/\.tex$/, "").endsWith(hit.key.replace(/\.tex$/, "")));
    if (target && !target.missing) {
      await openFile(target.path);
      return true;
    }
    notify("info", t("nav.fileMissing", { command: hit.command, key: hit.key }));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- compile

/** The compilation in progress, if any, and the project it belongs to. */
let running: { id: string; root: string } | null = null;
let jobCounter = 0;
/** A compile requested while another was running; it runs right after (same project only). */
let queued: { trigger: CompileTrigger; root: string } | null = null;

/** Stop compiling the current project (leaving it or opening another). */
function cancelCompile() {
  clearTimeout(liveTimer);
  queued = null;
  if (running) void cancelCompileJob(running.id);
}

const LIVE_PREVIEW_DELAY_MS = 1200;
let liveTimer: ReturnType<typeof setTimeout> | undefined;

/** Live preview: save and compile once the author pauses typing. */
export function scheduleLivePreview() {
  clearTimeout(liveTimer);
  if (!useSettings.getState().latex.livePreview || !useProject.getState().root) return;
  liveTimer = setTimeout(() => void compileProject("live"), LIVE_PREVIEW_DELAY_MS);
}

/** Save without prompting; files changed on disk wait for the banner decision. */
async function saveQuietly() {
  for (const f of useProject.getState().openFiles) {
    if (f.dirty && !f.external) await saveFile(f.path);
  }
}

export async function compileProject(trigger: CompileTrigger = "manual"): Promise<void> {
  const { root, doc } = useProject.getState();
  if (!root) return;
  if (running) {
    if (!queued || queued.root !== root || queued.trigger !== "manual") queued = { trigger, root };
    return;
  }
  if (trigger === "manual") clearTimeout(liveTimer);
  const mainFile = useProject.getState().mainFile ?? doc?.mainFile;
  if (!mainFile) {
    if (trigger === "manual") notify("error", t("compile.noMain"));
    return;
  }
  const job = { id: `compile-${++jobCounter}`, root };
  running = job;
  // A result that arrives after the author left this project must not touch the next one.
  const stillOpen = () => useProject.getState().root === root;
  try {
    if (trigger === "manual") await saveAll();
    else await saveQuietly();
    useProject.setState((s) => ({ compile: { ...s.compile, status: "running", error: undefined, trigger } }));
    const settings = useSettings.getState().latex;
    const result = await compileLatex({
      root,
      mainFile,
      compiler: settings.compiler,
      compilerPath: settings.compilerPath,
      customCommand: settings.customCommand,
      timeoutSecs: settings.timeoutSecs,
    }, job.id);
    if (!stillOpen()) return;
    const log = parseLatexLog(result.log, mainFile);
    const failed = !result.success || result.timedOut;
    if (failed && log.errors.length === 0) {
      log.errors.push({
        severity: "error",
        message: result.timedOut
          ? t("compile.timedOut", { seconds: settings.timeoutSecs })
          : /script engine|perl/i.test(result.output) && result.compiler === "latexmk"
            ? t("compile.perlMissing")
            : result.compiler === "tectonic" && /couldn't get it from the internet|error sending request|failed to download/i.test(result.output)
              ? t("compile.bundledOffline")
              : t("compile.failedGeneric"),
      });
    }
    useProject.setState((s) => ({
      compile: {
        status: failed ? "failed" : "success",
        trigger,
        result,
        log,
        pdfPath: result.pdfPath ?? s.compile.pdfPath,
        pdfVersion: result.pdfPath ? s.compile.pdfVersion + 1 : s.compile.pdfVersion,
      },
    }));
  } catch (err) {
    if (errorKind(err) === "cancelled" || !stillOpen()) return;
    useProject.setState((s) => ({
      compile: { ...s.compile, status: "failed", error: errorMessage(err), log: undefined, result: undefined, trigger },
    }));
  } finally {
    if (running === job) running = null;
    const next = queued;
    queued = null;
    if (next && next.root === useProject.getState().root) void compileProject(next.trigger);
  }
}

async function compileIdle(): Promise<void> {
  while (running) await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Compile if the PDF is not current, then save a copy where the author chooses. */
export async function exportPdf(): Promise<void> {
  const { root, name, doc } = useProject.getState();
  if (!root) return;
  if (!(await confirmDialog(t("export.confirm", { name: doc?.title || name }), "LOGICA", "info"))) return;
  await compileIdle();
  const { openFiles, compile } = useProject.getState();
  if (openFiles.some((f) => f.dirty) || compile.status !== "success" || !compile.pdfPath) {
    await compileProject("manual");
    await compileIdle();
  }
  if (useProject.getState().root !== root) return; // left the project meanwhile
  const { compile: after } = useProject.getState();
  if (after.status !== "success" || !after.pdfPath) {
    const first = after.log?.errors[0];
    const reason = after.error ?? (first ? `${first.message}${first.hint ? ` ${first.hint}` : ""}` : t("compile.failedGeneric"));
    notify("error", t("export.failed", { reason }));
    return;
  }
  try {
    const saved = await exportPdfFile(root, after.pdfPath, t("export.dialogTitle"));
    if (saved) notify("success", t("export.saved", { path: saved }));
  } catch (err) {
    notify("error", errorMessage(err));
  }
}

// ---------------------------------------------------------------- external changes

let checking = false;

/**
 * Detect files changed outside LOGICA. Clean buffers are reloaded silently;
 * buffers with unsaved edits get a banner so the author decides.
 */
export async function checkExternalChanges(): Promise<void> {
  const { root, openFiles } = useProject.getState();
  if (!root || checking) return;
  checking = true;
  try {
    const paths = [...new Set([...openFiles.map((f) => f.path), ...diskTexts.keys()])];
    const stats = await statFiles(root, paths);
    let changedSources = false;
    for (const stat of stats) {
      const meta = openFileMeta(stat.path);
      const known = meta ? meta.mtime : diskMtimes.get(stat.path);
      if (stat.mtime === null) {
        if (meta && meta.external !== "deleted") updateOpenFile(stat.path, { external: "deleted" });
        continue;
      }
      if (stat.mtime === known) continue;
      const file = await readTextFile(root, stat.path).catch(() => null);
      if (!file) continue;
      const previous = diskTexts.get(stat.path);
      diskTexts.set(stat.path, file.content);
      diskMtimes.set(stat.path, file.mtime);
      changedSources = true;
      if (!meta) continue;
      if (file.content === previous && !meta.external) {
        updateOpenFile(stat.path, { mtime: file.mtime });
      } else if (!editorSession.isDirty(stat.path)) {
        editorSession.replaceDocument(stat.path, file.content);
        updateOpenFile(stat.path, { mtime: file.mtime, external: undefined, dirty: false });
        notify("info", t("project.reloaded", { path: stat.path }));
      } else {
        updateOpenFile(stat.path, { external: "modified" });
      }
    }
    if (changedSources) scheduleRebuild(50);
  } catch {
    // Ignore transient errors (folder unmounted, permissions); try again later.
  } finally {
    checking = false;
  }
}

/** Resolve an external-change banner. */
export async function resolveExternalChange(path: string, choice: "reload" | "keep"): Promise<void> {
  const { root } = useProject.getState();
  const meta = openFileMeta(path);
  if (!root || !meta) return;
  if (choice === "keep") {
    // Keep the editor version; the next save overwrites the disk version.
    const stat = (await statFiles(root, [path]))[0];
    updateOpenFile(path, { external: undefined, mtime: stat?.mtime ?? meta.mtime });
    if (stat?.mtime == null) updateOpenFile(path, { external: "deleted" });
    return;
  }
  try {
    const file = await readTextFile(root, path);
    editorSession.replaceDocument(path, file.content);
    diskTexts.set(path, file.content);
    diskMtimes.set(path, file.mtime);
    updateOpenFile(path, { mtime: file.mtime, external: undefined, dirty: false });
    scheduleRebuild(50);
  } catch (err) {
    notify("error", t("project.reloadError", { path, error: errorMessage(err) }));
  }
}

// ---------------------------------------------------------------- editor wiring

/** Connect editor events to the project state. Call once at startup. */
export function connectEditorSession() {
  editorSession.listener = {
    onDocChanged: () => {
      scheduleRebuild();
      scheduleLivePreview();
    },
    onSelectionChanged: (path, state) => updateCursor(path, state),
    onDirtyChanged: (path, dirty) => updateOpenFile(path, { dirty }),
    onActivated: (path) => {
      useProject.setState({ activePath: path });
      rememberOpenFiles();
    },
  };
}
