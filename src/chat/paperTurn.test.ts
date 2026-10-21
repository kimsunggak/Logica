import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiService } from "../ai/service";
import { call } from "../lib/backend";
import { useProject } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";
import { samplePaper, sampleSources } from "../test/samplePaper";
import { sendChatMessage, summaryIdle, useChat } from "./chatStore";
import { loadReport } from "./paper/report";

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
  it("reads the whole paper first, summarizes its sections, then reads only the sections a question needs", async () => {
    const generate = vi.spyOn(aiService, "generate");
    try {
      await sendChatMessage("What does Table 1 report?");
      const first = generate.mock.calls.find(([, r]) => r.task === "answer")![1];
      expect(first.projectFiles?.map((f) => f.path)).toContain("sections/method.tex");
      expect(first.paperView).toBeUndefined();

      // After the turn, the Section Summary Module writes the report.
      await summaryIdle();
      const report = await loadReport(ROOT);
      expect(Object.keys(report.summaries).length).toBe(16);
      expect(generate.mock.calls.filter(([, r]) => r.task === "sections")).toHaveLength(1);

      generate.mockClear();
      await sendChatMessage("Explain the Uncertainty Estimation section");
      const judge = generate.mock.calls.find(([, r]) => r.task === "judge")![1];
      expect(judge.paperMap?.find((e) => e.key === "3.2")?.summary).toContain("Uncertainty Estimation");
      const answer = generate.mock.calls.find(([, r]) => r.task === "answer")![1];
      expect(answer.projectFiles).toBeUndefined();
      const read = Object.fromEntries(answer.paperView!.sections.map((s) => [s.key, s.content]));
      expect(read).toMatchObject({ front: "full", "3.2": "full", "3.3": "summary", "1": "summary" });
      expect(useChat.getState().messages.at(-1)!.content).toContain("sections front, 3.2 word for word");
      // Nothing changed in the paper: no section is summarized again.
      await summaryIdle();
      expect(generate.mock.calls.filter(([, r]) => r.task === "sections")).toHaveLength(0);

      // An edited section is read word for word until it is summarized again.
      files = samplePaper();
      files.set("sections/method.tex", sampleSources.methodTex.replace("keeps the cost low", "keeps the cost very low"));
      generate.mockClear();
      await sendChatMessage("What does Table 1 report?");
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
