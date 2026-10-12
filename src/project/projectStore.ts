/**
 * Runtime state of the open project (not persisted directly; the parts worth
 * remembering are copied into the workspace store).
 */
import { create } from "zustand";
import type { BibEntry, BibParseError } from "../latex/bibtex/bibParser";
import type { CompileResult } from "../latex/compiler/compileApi";
import type { ParsedLog } from "../latex/compiler/logParser";
import type { PaperDocument } from "../latex/parser/documentModel";
import type { ProjectEntry } from "./projectApi";

export interface OpenFileMeta {
  path: string;
  /** Disk modification time when the file was last read or written. */
  mtime: number;
  dirty: boolean;
  lossy: boolean;
  /** Set when the file changed on disk while it had unsaved edits. */
  external?: "modified" | "deleted";
}

export type CompileStatus = "idle" | "running" | "success" | "failed";

export interface CompileState {
  status: CompileStatus;
  result?: CompileResult;
  log?: ParsedLog;
  /** Error that prevented compilation (missing compiler, timeout, ...). */
  error?: string;
  pdfPath?: string;
  /** Incremented whenever a new PDF is available. */
  pdfVersion: number;
}

export interface Notice {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

export interface CursorInfo {
  line: number;
  column: number;
  selectionLength: number;
}

interface ProjectState {
  root: string | null;
  name: string;
  entries: ProjectEntry[];
  mainFile?: string;
  openFiles: OpenFileMeta[];
  activePath: string | null;
  doc: PaperDocument | null;
  bibEntries: BibEntry[];
  bibErrors: BibParseError[];
  currentSectionId: string | null;
  cursor: CursorInfo;
  compile: CompileState;
  notices: Notice[];
  loading: boolean;
}

export const initialProjectState: ProjectState = {
  root: null,
  name: "",
  entries: [],
  openFiles: [],
  activePath: null,
  doc: null,
  bibEntries: [],
  bibErrors: [],
  currentSectionId: null,
  cursor: { line: 1, column: 1, selectionLength: 0 },
  compile: { status: "idle", pdfVersion: 0 },
  notices: [],
  loading: false,
};

export const useProject = create<ProjectState>()(() => ({ ...initialProjectState }));

export function updateOpenFile(path: string, patch: Partial<OpenFileMeta>) {
  useProject.setState((s) => ({
    openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, ...patch } : f)),
  }));
}

export function openFileMeta(path: string): OpenFileMeta | undefined {
  return useProject.getState().openFiles.find((f) => f.path === path);
}

let noticeId = 0;

export function notify(kind: Notice["kind"], text: string, timeoutMs = 5000) {
  const id = ++noticeId;
  useProject.setState((s) => ({ notices: [...s.notices.slice(-3), { id, kind, text }] }));
  if (timeoutMs > 0) setTimeout(() => dismissNotice(id), timeoutMs);
}

export function dismissNotice(id: number) {
  useProject.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}
