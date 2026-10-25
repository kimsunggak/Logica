import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiService } from "../ai/service";
import { call } from "../lib/backend";
import { useSettings } from "../settings/settingsStore";
import { sendChatMessage, stopChat, summaryIdle, useChat } from "./chatStore";
import { renderSummary } from "./session/summary";
import { turnsOf } from "./session/turns";

const demo = globalThis as { __LOGICA_DEMO_FAIL_OPENAI?: boolean };
const answer = () => useChat.getState().messages.at(-1)!;

beforeAll(async () => {
  useSettings.getState().updateAI({ openaiAuth: "api_key" });
  await call("credential_set", { provider: "openai", secret: "sk-demo-openai-0000" });
  await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
});

beforeEach(async () => {
  // A summary still being made for the previous test must not land in this one.
  await summaryIdle();
  demo.__LOGICA_DEMO_FAIL_OPENAI = false;
  useChat.setState({ messages: [], runningId: null, summary: null });
});

describe("chat turn through the demo backend", () => {
  it("A: small talk is routed by the judge and answered by the Reply Module", async () => {
    await sendChatMessage("고마워");
    expect(answer()).toMatchObject({ status: "done", route: "reply", content: "천만에요! 논문에 대해 궁금한 점을 물어보세요.", provider: "openai", model: "gpt-6.1-sol" });
    expect(answer().refined).toBeUndefined();
  });

  it("B: a clear question goes straight to the Answer Module", async () => {
    await sendChatMessage("What does Table 2 report?");
    expect(answer()).toMatchObject({ status: "done", route: "answer", model: "gpt-6.1-sol" });
    expect(answer().content).toContain('Demo answer to "What does Table 2 report?"');
    expect(answer().refined).toBeUndefined();
  });

  it("C: an abstract question is refined first, and the answer uses the refined question", async () => {
    await sendChatMessage("이 논문 핵심이 뭐야?");
    const message = answer();
    expect(message).toMatchObject({ status: "done", route: "answer" });
    expect(message.refined).toContain("이 논문 핵심이 뭐야?");
    expect(message.refined).toContain("핵심 아이디어");
    expect(message.content).toContain(`Demo answer to "${message.refined}"`);
  });

  it("C: a question that cannot be settled is asked back", async () => {
    await sendChatMessage("이거?");
    expect(answer()).toMatchObject({ status: "done", route: "clarify", content: "어느 부분을 말씀하시는 건가요? 섹션이나 문장을 알려 주세요." });
  });

  it("sends earlier exchanges as conversation history", async () => {
    await sendChatMessage("고마워");
    await sendChatMessage("What does Table 2 report?");
    expect(useChat.getState().messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "done"],
      ["assistant", "done"],
      ["user", "done"],
      ["assistant", "done"],
    ]);
  });

  it("keeps a failed turn in the conversation, marked as not answered", async () => {
    // The first question has no earlier turns.
    expect(turnsOf(useChat.getState().messages)).toHaveLength(0);
    await sendChatMessage("고마워");
    expect(turnsOf(useChat.getState().messages)).toHaveLength(1);
    demo.__LOGICA_DEMO_FAIL_OPENAI = true;
    await call("credential_delete", { provider: "anthropic" });
    try {
      await sendChatMessage("What does Table 2 report?");
    } finally {
      await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
    }
    expect(answer().status).toBe("error");
    const turns = turnsOf(useChat.getState().messages);
    expect(turns.map((t) => [t.index, t.status])).toEqual([
      [1, "done"],
      [2, "error"],
    ]);
    // The next question's judge reads it with the note, not the error text.
    demo.__LOGICA_DEMO_FAIL_OPENAI = false;
    const generate = vi.spyOn(aiService, "generate");
    try {
      await sendChatMessage("고마워");
      const judge = generate.mock.calls.find(([, request]) => request.task === "judge")![1];
      expect(judge.history?.at(-1)).toEqual({ role: "assistant", content: "[answer failed]" });
    } finally {
      generate.mockRestore();
    }
  });

  it("folds all but the last four turns into the session summary once ten are open", async () => {
    const questions = [
      "앞으로 답은 짧게 해줘",
      "What does Table 2 report?",
      "고마워",
      "What is in Section 3?",
      "Define the routing loss",
      "What does Figure 1 show?",
      "Which datasets are used?",
      "What is the baseline?",
      "Explain the occlusion results",
      "What are the limitations?",
    ];
    const covered: number[] = [];
    for (const q of questions) {
      await sendChatMessage(q);
      await summaryIdle();
      covered.push(useChat.getState().summary?.coveredTurns ?? 0);
    }
    // Nothing is folded before ten turns are open; then all but the last four are.
    expect(covered).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
    const summary = useChat.getState().summary!;
    expect(summary.topic).not.toBe("");
    expect(summary.goal).not.toBe("");
    // Small talk (turn 3) gets no history line.
    expect(summary.items.map((item) => [item.kind, item.turn])).toEqual([
      ["preference", 1],
      ["history", 2],
      ["history", 4],
      ["history", 5],
      ["history", 6],
    ]);
    expect(renderSummary(summary)).toContain("Turns 1-6 of this conversation are folded");

    // The next question reads the summary and the four turns after it.
    const generate = vi.spyOn(aiService, "generate");
    try {
      await sendChatMessage("What does Table 3 report?");
      for (const task of ["judge", "answer"]) {
        const request = generate.mock.calls.find(([, r]) => r.task === task)![1];
        expect(request.sessionSummary).toContain("P1: 앞으로 답은 짧게 해줘");
        expect(request.history?.filter((m) => m.role === "user").map((m) => m.content)).toEqual(questions.slice(6));
      }
    } finally {
      generate.mockRestore();
    }
  }, 60_000);

  it("falls back to Claude when OpenAI fails, and says so", async () => {
    demo.__LOGICA_DEMO_FAIL_OPENAI = true;
    await sendChatMessage("이 논문 핵심이 뭐야?");
    const message = answer();
    expect(message).toMatchObject({ status: "done", route: "answer", provider: "anthropic", model: "claude-sonnet-5-5", fallbackFrom: "gpt-6.1-sol" });
    expect(message.refined).toContain("핵심 아이디어");
  });

  it("reports both errors when Claude is not connected and OpenAI fails", async () => {
    demo.__LOGICA_DEMO_FAIL_OPENAI = true;
    await call("credential_delete", { provider: "anthropic" });
    try {
      await sendChatMessage("What does Table 2 report?");
      expect(answer().status).toBe("error");
      expect(answer().content).toContain("Claude (Anthropic) is not connected");
      expect(answer().content).toContain("OpenAI also failed");
    } finally {
      await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
    }
  });

  it("uses GPT for judge when Claude is not connected", async () => {
    await call("credential_delete", { provider: "anthropic" });
    const generate = vi.spyOn(aiService, "generate");
    try {
      await sendChatMessage("고마워");
      expect(answer()).toMatchObject({ status: "done", route: "reply", provider: "openai", model: "gpt-6.1-sol" });
      const judge = generate.mock.calls.filter(([, request]) => request.task === "judge").map(([provider, request]) => [provider, request.model]);
      expect(judge).toEqual([
        ["anthropic", "claude-sonnet-5-5"],
        ["openai", "gpt-6.1-sol"],
      ]);
    } finally {
      generate.mockRestore();
      await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
    }
  });

  it("stops a running turn without falling back", async () => {
    const running = sendChatMessage("이 논문 핵심이 뭐야?");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stopChat();
    await running;
    expect(answer().status).toBe("cancelled");
    expect(useChat.getState().runningId).toBeNull();
  });
});
