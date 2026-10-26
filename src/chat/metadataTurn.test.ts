// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { aiService } from "../ai/service";
import { editorSession } from "../editor/editorSession";
import { call } from "../lib/backend";
import { useProject } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";
import { samplePaper } from "../test/samplePaper";
import { applyChatEdit, sendChatMessage, summaryIdle, useChat } from "./chatStore";
import { METADATA } from "./paper/metadata";
import { forgetReports } from "./paper/report";

let files = samplePaper();
const ROOT = "/demo/sample-paper";
vi.mock("../project/projectActions", async (original) => ({
  ...(await original<object>()),
  currentTexts: () => {
    const texts = new Map(files);
    for (const path of editorSession.openPaths()) texts.set(path, editorSession.textOf(path)!);
    return texts;
  },
  openFile: async (path: string) => {
    const text = files.get(path);
    if (text === undefined) return false;
    editorSession.open(path, text);
    return true;
  },
  navigateTo: vi.fn(async () => {}),
}));

interface SavedReport {
  title: string;
  sections: { key: string; hash: string; summary: string | null }[];
}
async function savedReport(root: string): Promise<SavedReport> {
  const yaml = await call<string | null>("paper_load_summary", { root });
  expect(yaml).not.toBeNull();
  return parse(yaml!) as SavedReport;
}
const metadata = (report: SavedReport) => report.sections.find((section) => section.key === METADATA)!;

beforeAll(async () => {
  useSettings.getState().updateUI({ language: "en" });
  useSettings.getState().updateAI({ openaiAuth: "api_key" });
  await call("credential_set", { provider: "openai", secret: "sk-demo-openai-0000" });
  await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
});
beforeEach(async () => {
  await summaryIdle();
  for (const path of editorSession.openPaths()) editorSession.close(path);
  files = samplePaper();
  await call("paper_save_summary", { root: ROOT, text: "" });
  forgetReports();
});

describe("metadata editing through the demo gateway and chat store", () => {
  it.each([
    { language: "English", title: "New title", authors: "Ada and Bob", titleRequest: 'Change the paper title to "New title"', authorRequest: 'Change the authors to "Ada and Bob"' },
    { language: "Korean", title: "새 논문 제목", authors: "김연구와 이저자", titleRequest: '논문 제목을 "새 논문 제목"으로 바꿔줘', authorRequest: '저자를 "김연구와 이저자"로 바꿔줘' },
  ])("proposes and applies title and author changes in $language", async ({ title, authors, titleRequest, authorRequest }) => {
    const root = ROOT;
    useProject.setState({ root, mainFile: "main.tex" });
    useChat.setState({ root, sessionId: root.slice(root.lastIndexOf("/") + 1), messages: [], runningId: null, summary: null, mode: "edit", sessions: [] });
    const generate = vi.spyOn(aiService, "generate");
    try {
      const originalFile = files.get("main.tex")!;
      await sendChatMessage(titleRequest);
      await summaryIdle();
      const titleProposal = useChat.getState().messages.at(-1)!;
      expect(titleProposal).toMatchObject({ status: "done", route: "edit", mode: "edit" });
      expect(titleProposal.editToolCallId).toBeTruthy();
      expect(titleProposal.edits).toHaveLength(1);
      expect(titleProposal.edits![0]).toMatchObject({ path: "main.tex", revised: `\\title{${title}}` });
      expect(titleProposal.edits![0].original).toMatch(/^\\title\{/);
      expect(titleProposal.editStates).toBeUndefined();
      expect(editorSession.has("main.tex")).toBe(false);
      expect(files.get("main.tex")).toBe(originalFile);
      const before = await savedReport(root);
      expect(before.title).not.toBe(title);
      expect(metadata(before).summary).not.toContain(`Title: ${title}`);

      const selected = generate.mock.calls.find(([, request]) => request.task === "edit")![1];
      expect(selected.editSections).toEqual([METADATA]);
      expect(selected.paperView!.sections.find((section) => section.key === METADATA)).toMatchObject({ content: "full" });
      expect(generate.mock.calls.filter(([, request]) => request.task === "sections").every(([, request]) => request.sectionsToSummarize?.every((section) => section.key !== METADATA))).toBe(true);

      await applyChatEdit(titleProposal.id, 0, titleProposal.edits![0]);
      await summaryIdle();
      expect(editorSession.textOf("main.tex")).toBe(originalFile.replace(titleProposal.edits![0].original, titleProposal.edits![0].revised));
      expect(useChat.getState().messages.at(-1)!.editStates).toEqual({ 0: "applied" });
      const afterTitle = await savedReport(root);
      expect(afterTitle.title).toBe(title);
      expect(metadata(afterTitle).summary).toContain(`Title: ${title}`);
      expect(metadata(afterTitle).hash).not.toBe(metadata(before).hash);
      expect(afterTitle.sections.find((section) => section.key === "abstract")!.hash).toBe(before.sections.find((section) => section.key === "abstract")!.hash);

      const beforeAuthor = editorSession.textOf("main.tex")!;
      await sendChatMessage(authorRequest);
      await summaryIdle();
      const authorProposal = useChat.getState().messages.at(-1)!;
      expect(authorProposal).toMatchObject({ status: "done", route: "edit", mode: "edit" });
      expect(authorProposal.edits).toHaveLength(1);
      expect(authorProposal.edits![0]).toMatchObject({ path: "main.tex", original: "\\author{Anonymous Author}", revised: `\\author{${authors}}` });
      expect(editorSession.textOf("main.tex")).toBe(beforeAuthor);
      await applyChatEdit(authorProposal.id, 0, authorProposal.edits![0]);
      await summaryIdle();
      const afterAuthors = await savedReport(root);
      expect(afterAuthors.title).toBe(title);
      expect(metadata(afterAuthors).summary).toContain(`Authors: ${authors}`);
      expect(metadata(afterAuthors).hash).not.toBe(metadata(afterTitle).hash);
      expect(editorSession.textOf("main.tex")).toBe(beforeAuthor.replace(authorProposal.edits![0].original, authorProposal.edits![0].revised));
    } finally {
      generate.mockRestore();
    }
  }, 60_000);
});
