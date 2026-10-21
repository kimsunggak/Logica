import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiService } from "../ai/service";
import { call } from "../lib/backend";
import { useProject } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";
import { samplePaper, sampleSources } from "../test/samplePaper";
import { sendChatMessage, summaryIdle, useChat } from "./chatStore";
import { loadReport } from "./paper/report";
import { NO_CONTENT } from "./paper/sectionSummarizer";

// The sample paper as the open project's files.
let files = samplePaper();
vi.mock("../project/projectActions", async (original) => ({ ...(await original<object>()), currentTexts: () => files }));

const ROOT = "/demo/sample-paper";

beforeAll(async () => {
  useSettings.getState().updateUI({ language: "en" });
  useSettings.getState().updateAI({ openaiAuth: "api_key" });
  await call("credential_set", { provider: "openai", secret: "sk-demo-openai-0000" });
  await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
  useProject.setState({ root: ROOT, mainFile: "main.tex" });
  useChat.setState({ messages: [], runningId: null, summary: null });
});

describe("reading the paper by sections, through the demo backend", () => {
  it("summarizes the paper before the first answer, then reads only the sections a question needs", async () => {
    const generate = vi.spyOn(aiService, "generate");
    const tasks = () => generate.mock.calls.map(([, r]) => r.task);
    try {
      // The first question: the paper is summarized before the judge runs.
      await sendChatMessage("What does Table 1 report?");
      expect(tasks()).toEqual(["sections", "judge", "answer"]);
      const report = await loadReport(ROOT);
      expect(Object.keys(report.summaries)).toHaveLength(17);
      const first = generate.mock.calls.find(([, r]) => r.task === "answer")![1];
      expect(first.projectFiles).toBeUndefined();
      expect(Object.fromEntries(first.paperView!.sections.map((s) => [s.key, s.content]))).toMatchObject({ abstract: "full", "4.3": "summary" });
      const judge = generate.mock.calls.find(([, r]) => r.task === "judge")![1];
      expect(judge.paperMap?.find((e) => e.key === "3")?.summary).toBe(NO_CONTENT);
      // Nothing is left to summarize after the turn.
      await summaryIdle();
      expect(tasks().filter((t) => t === "sections")).toHaveLength(1);

      generate.mockClear();
      await sendChatMessage("Explain the Uncertainty Estimation section");
      expect(tasks()).toEqual(["judge", "answer"]);
      const answer = generate.mock.calls.find(([, r]) => r.task === "answer")![1];
      const read = Object.fromEntries(answer.paperView!.sections.map((s) => [s.key, s.content]));
      expect(read).toMatchObject({ abstract: "full", "3.2": "full", "3.3": "summary", "1": "summary" });
      expect(useChat.getState().messages.at(-1)!.content).toContain("sections abstract, 3.2 word for word");
      await summaryIdle();
      expect(tasks()).not.toContain("sections");

      // An edited section is read word for word, and summarized again after the turn.
      files = samplePaper();
      files.set("sections/method.tex", sampleSources.methodTex.replace("keeps the cost low", "keeps the cost very low"));
      generate.mockClear();
      await sendChatMessage("What does Table 1 report?");
      // The edited section is summarized after the turn, in the background.
      expect(tasks().filter((t) => t !== "sections")).toEqual(["judge", "answer"]);
      const edited = generate.mock.calls.find(([, r]) => r.task === "answer")![1];
      expect(Object.fromEntries(edited.paperView!.sections.map((s) => [s.key, s.content]))).toMatchObject({ "3.3": "full", "3.2": "summary" });
      await summaryIdle();
      const again = generate.mock.calls.filter(([, r]) => r.task === "sections").map(([, r]) => r.sectionsToSummarize?.map((s) => s.key));
      expect(again).toEqual([["3.3"]]);
    } finally {
      generate.mockRestore();
    }
  }, 30_000);
});
