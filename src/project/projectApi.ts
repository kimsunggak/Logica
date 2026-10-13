/** Typed wrappers for the project file commands of the backend. */
import { call } from "../lib/backend";

export interface ProjectEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface ProjectListing {
  root: string;
  entries: ProjectEntry[];
  truncated: boolean;
}

export interface TextFile {
  content: string;
  mtime: number;
  lossy: boolean;
}

export interface FileStat {
  path: string;
  mtime: number | null;
}

export function listProjectFiles(root: string): Promise<ProjectListing> {
  return call<ProjectListing>("list_project_files", { root });
}

export function readTextFile(root: string, path: string): Promise<TextFile> {
  return call<TextFile>("read_text_file", { root, path });
}

export function writeTextFile(
  root: string,
  path: string,
  content: string,
  expectedMtime?: number,
  force = false,
): Promise<{ mtime: number }> {
  return call<{ mtime: number }>("write_text_file", { root, path, content, expectedMtime, force });
}

export function statFiles(root: string, paths: string[]): Promise<FileStat[]> {
  return call<FileStat[]>("stat_files", { root, paths });
}

export function readBinaryFile(root: string, path: string): Promise<ArrayBuffer> {
  return call<ArrayBuffer>("read_binary_file", { root, path });
}

/** Create a one-page starter paper (Documents/LOGICA/My Paper…) and return its folder. */
export function createStarterProject(reuse: boolean): Promise<string> {
  return call<string>("create_starter_project", { reuse });
}

/** Native save dialog plus copy; resolves to the saved path, or null if cancelled. */
export function exportPdfFile(root: string, path: string, title: string): Promise<string | null> {
  return call<string | null>("export_pdf", { root, path, title });
}

export function pathExists(root: string, path: string): Promise<boolean> {
  return call<boolean>("path_exists", { root, path });
}
