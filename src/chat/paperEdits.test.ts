import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposedEdit } from "../ai/agent/edits";
import { editorSession } from "../editor/editorSession";
import { useProject } from "../project/projectStore";
import { applyAllChatEdits, applyChatEdit, rejectChatEdit, summaryIdle, useChat, type ChatMessage } from "./chatStore";
import { call } from "../lib/backend";

const { files, open, navigate } = vi.hoisted(() => ({ files: new Map<string, string>(), open: vi.fn(), navigate: vi.fn() }));
vi.mock("../project/projectActions", () => ({
  currentTexts: () => {
    const texts = new Map(files);
    for (const path of editorSession.openPaths()) texts.set(path, editorSession.textOf(path)!);
    return texts;
  },
  openFile: open, navigateTo: navigate,
}));
vi.mock("../lib/backend", () => ({ call: vi.fn(async () => null), isDesktop: () => false }));
const original = "\\documentclass{article}\n\\begin{document}\n\\section{Method}\nFirst sentence.\nSecond sentence.\n\\end{document}\n";
const first: ProposedEdit = { path: "main.tex", original: "First sentence.", revised: "Revised first sentence." };
const second: ProposedEdit = { path: "main.tex", original: "Second sentence.", revised: "Revised second." };
function proposal(edits = [first], patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "answer", role: "assistant", content: "Proposed changes.", status: "done", mode: "edit", route: "edit", editToolCallId: "call-1", edits, ...patch };
}
beforeEach(async () => {
  await summaryIdle();
  for (const path of editorSession.openPaths()) editorSession.close(path);
  files.clear(); files.set("main.tex", original);
  open.mockReset().mockImplementation(async (path: string) => {
    if (!files.has(path)) return false;
    editorSession.open(path, files.get(path)!);
    return true;
  });
  navigate.mockReset();
  vi.mocked(call).mockClear();
  useProject.setState({ root: "/project", mainFile: "main.tex" });
  useChat.setState({ root: "/project", sessionId: "s1", mode: "edit", messages: [proposal()], runningId: null, summary: null });
});

describe("accepted apply_paper_edits execution", () => {
  it("applies a reviewed replacement through the editor and refreshes the paper summary", async () => {
    expect(editorSession.has("main.tex")).toBe(false);
    await applyChatEdit("answer", 0, first);
    expect(editorSession.textOf("main.tex")).toBe(original.replace(first.original, first.revised));
    expect(editorSession.isDirty("main.tex")).toBe(true);
    expect(useChat.getState().messages[0].editStates).toEqual({ 0: "applied" });
    await summaryIdle();
    expect(vi.mocked(call).mock.calls.some(([cmd]) => cmd === "paper_save_summary")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("main.tex", 4);
  });

  it("applies multiple positions and files after a complete preflight", async () => {
    files.set("intro.tex", "Introduction.\nKeep this.");
    const intro = { path: "intro.tex", original: "Introduction.", revised: "New introduction." };
    useChat.setState({ messages: [proposal([first, second, intro])] });
    await applyAllChatEdits("answer", [first, second, intro].map((edit, index) => ({ edit, index })));
    expect(editorSession.textOf("main.tex")).toBe(original.replace(first.original, first.revised).replace(second.original, second.revised));
    expect(editorSession.textOf("intro.tex")).toBe("New introduction.\nKeep this.");
    expect(useChat.getState().messages[0].editStates).toEqual({ 0: "applied", 1: "applied", 2: "applied" });
  });

  it("leaves the entire batch untouched if one anchor has changed", async () => {
    const changed = { ...second, original: "Outdated second sentence." };
    useChat.setState({ messages: [proposal([first, changed])] });
    await applyAllChatEdits("answer", [first, changed].map((edit, index) => ({ edit, index })));
    expect(editorSession.textOf("main.tex")).toBe(original);
    expect(useChat.getState().messages[0].editStates).toEqual({ 0: "failed", 1: "failed" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses unsaved buffers and refuses a stale original even when only whitespace changed", async () => {
    editorSession.open("main.tex", original.replace("First sentence.", "First  sentence."));
    await applyChatEdit("answer", 0, first);
    expect(editorSession.textOf("main.tex")).toContain("First  sentence.");
    expect(useChat.getState().messages[0].editStates?.[0]).toBe("failed");
  });

  it("rejects duplicate anchors and overlapping changes", async () => {
    editorSession.open("main.tex", original + first.original);
    await applyChatEdit("answer", 0, first);
    expect(editorSession.textOf("main.tex")).not.toContain(first.revised);
    const overlap = { ...first, original: "sentence.", revised: "text." };
    useChat.setState({ messages: [proposal([first, overlap])] });
    editorSession.close("main.tex");
    await applyAllChatEdits("answer", [{ index: 0, edit: first }, { index: 1, edit: overlap }]);
    expect(editorSession.textOf("main.tex")).toBe(original);
  });

  it.each([
    { mode: "chat" as const }, { route: "chat" as const }, { status: "cancelled" as const },
    { truncated: true }, { editToolCallId: undefined },
  ])("cannot execute a proposal in a non-executable message %j", async (patch) => {
    useChat.setState({ messages: [proposal([first], patch)] });
    await applyChatEdit("answer", 0, first);
    expect(open).not.toHaveBeenCalled();
    expect(editorSession.has("main.tex")).toBe(false);
  });

  it("refuses changed tool arguments, rejected edits, and repeat execution", async () => {
    await applyChatEdit("answer", 0, { ...first, revised: "Unapproved text." });
    expect(open).not.toHaveBeenCalled();
    rejectChatEdit("answer", 0);
    await applyChatEdit("answer", 0, first);
    expect(open).not.toHaveBeenCalled();
    useChat.setState({ messages: [proposal()] });
    await applyChatEdit("answer", 0, first);
    await applyChatEdit("answer", 0, first);
    expect(useChat.getState().messages[0].editStates?.[0]).toBe("applied");
  });

  it("abandons application when the session changes while a file is opening", async () => {
    open.mockImplementation(async (path) => {
      editorSession.open(path, files.get(path)!);
      useChat.setState({ sessionId: "another-session", messages: [] });
      return true;
    });
    await applyChatEdit("answer", 0, first);
    expect(editorSession.textOf("main.tex")).toBe(original);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("requires the proposal's project to still be open", async () => {
    useProject.setState({ root: "/another-project" });
    await applyChatEdit("answer", 0, first);
    expect(open).not.toHaveBeenCalled();
  });
});
