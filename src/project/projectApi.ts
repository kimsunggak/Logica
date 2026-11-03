/** Typed wrappers for the project file commands of the backend. */
import { call } from "../lib/backend";
import type { PaperTemplateId } from "./templates";

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

export async function readTextFile(root: string, path: string): Promise<TextFile> {
  const file = await call<TextFile>("read_text_file", { root, path });
  // CodeMirror stores lines with LF. Use that representation before parsing,
  // hashing or sending source to a model, including files not opened yet.
  return { ...file, content: file.content.replace(/\r\n?/g, "\n") };
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

export interface ConvertedFile {
  content: string;
  mtime: number;
  /** Encoding the original was decoded from (e.g. `EUC-KR`). */
  encoding: string;
  /** Project-relative path of the untouched original. */
  backup: string;
}

/** Rewrite a file that is not UTF-8 as UTF-8; the backend keeps the original as a backup. */
export async function convertTextFileToUtf8(root: string, path: string): Promise<ConvertedFile> {
  const file = await call<ConvertedFile>("convert_text_file_to_utf8", { root, path });
  return { ...file, content: file.content.replace(/\r\n?/g, "\n") };
}

export function statFiles(root: string, paths: string[]): Promise<FileStat[]> {
  return call<FileStat[]>("stat_files", { root, paths });
}

export function readBinaryFile(root: string, path: string): Promise<ArrayBuffer> {
  return call<ArrayBuffer>("read_binary_file", { root, path });
}

/** Create a paper from a template (Documents/LOGICA/My Paper…, CVPR Paper…) and return its folder. */
export function createStarterProject(template: PaperTemplateId, reuse: boolean): Promise<string> {
  return call<string>("create_starter_project", { template, reuse });
}

/** Native save dialog plus copy; resolves to the saved path, or null if cancelled. */
export function exportPdfFile(root: string, path: string, title: string): Promise<string | null> {
  return call<string | null>("export_pdf", { root, path, title });
}

export function pathExists(root: string, path: string): Promise<boolean> {
  return call<boolean>("path_exists", { root, path });
}
