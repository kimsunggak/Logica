import { history, undoDepth } from "@codemirror/commands";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorSession } from "../editor/editorSession";
import { call, confirmDialog } from "../lib/backend";
import { convertToUtf8, openFile, saveFile } from "./projectActions";
import { initialProjectState, openFileMeta, useProject } from "./projectStore";

vi.mock("../lib/backend", async (original) => ({ ...(await original<object>()), call: vi.fn(), confirmDialog: vi.fn(async () => true) }));

const ROOT = "/papers/legacy";
const PATH = "main.tex";
// What the backend reads from an EUC-KR file: the Hangul became replacement characters.
const decoded = "\\section{\uFFFD\uFFFD}\n";

beforeEach(() => {
  vi.mocked(call).mockReset().mockImplementation((async (command: string) => {
    if (command === "read_text_file") return { content: decoded, mtime: 1, lossy: true };
    if (command === "convert_text_file_to_utf8") return { content: "\\section{서론}\r\n", mtime: 2, encoding: "EUC-KR", backup: "main.tex.euc-kr.bak" };
    if (command === "write_text_file") return { mtime: 3 };
    throw new Error(`unexpected command ${command}`);
  }) as typeof call);
  vi.mocked(confirmDialog).mockClear();
  editorSession.setBaseExtensions([history()]);
  for (const path of editorSession.openPaths()) editorSession.close(path);
  useProject.setState({ ...initialProjectState, root: ROOT });
});

describe("files that are not UTF-8", () => {
  it("open read-only and are never saved before they are converted", async () => {
    expect(await openFile(PATH)).toBe(true);
    expect(openFileMeta(PATH)?.lossy).toBe(true);
    expect(editorSession.isReadOnly(PATH)).toBe(true);
    expect(editorSession.applyEdit(PATH, 0, 0, "x")).toBe(false);
    expect(await saveFile(PATH, true)).toBe(false);
    expect(call).not.toHaveBeenCalledWith("write_text_file", expect.anything());
  });

  it("become editable after conversion, with the decoded text", async () => {
    await openFile(PATH);
    await convertToUtf8(PATH);
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("convert_text_file_to_utf8", { root: ROOT, path: PATH });
    expect(editorSession.textOf(PATH)).toBe("\\section{서론}\n");
    expect(editorSession.isReadOnly(PATH)).toBe(false);
    // Undo cannot bring back the text with replacement characters.
    expect(undoDepth(editorSession.stateOf(PATH)!)).toBe(0);
    expect(openFileMeta(PATH)).toMatchObject({ lossy: false, dirty: false, mtime: 2 });
    expect(editorSession.applyEdit(PATH, 0, 0, "% ")).toBe(true);
    expect(await saveFile(PATH)).toBe(true);
    expect(call).toHaveBeenCalledWith("write_text_file", expect.objectContaining({ path: PATH, content: "% \\section{서론}\n", expectedMtime: 2 }));
  });

  it("stay read-only when the author does not confirm the conversion", async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await openFile(PATH);
    await convertToUtf8(PATH);
    expect(call).not.toHaveBeenCalledWith("convert_text_file_to_utf8", expect.anything());
    expect(editorSession.isReadOnly(PATH)).toBe(true);
  });
});
