import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "../lib/backend";
import { useSettings } from "../settings/settingsStore";
import { conversation, sendChatMessage, stopChat, useChat } from "./chatStore";
import { turnCount } from "./orchestrator";

const demo = globalThis as { __LOGICA_DEMO_FAIL_OPENAI?: boolean };
const answer = () => useChat.getState().messages.at(-1)!;

beforeAll(async () => {
  useSettings.getState().updateAI({ openaiAuth: "api_key" });
  await call("credential_set", { provider: "openai", secret: "sk-demo-openai-0000" });
  await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
});

beforeEach(() => {
  demo.__LOGICA_DEMO_FAIL_OPENAI = false;
  useChat.setState({ messages: [], runningId: null });
});

describe("chat turn through the demo backend", () => {
  it("A: small talk is answered by the orchestrator itself", async () => {
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

  it("counts a turn only once its answer is finished", async () => {
    // The first question has no earlier turns.
    expect(turnCount(conversation())).toBe(0);
    await sendChatMessage("고마워");
    expect(turnCount(conversation())).toBe(1);
    // A question whose answer failed is not a turn.
    demo.__LOGICA_DEMO_FAIL_OPENAI = true;
    await call("credential_delete", { provider: "anthropic" });
    try {
      await sendChatMessage("What does Table 2 report?");
    } finally {
      await call("credential_set", { provider: "anthropic", secret: "sk-ant-demo-0000" });
    }
    expect(answer().status).toBe("error");
    expect(turnCount(conversation())).toBe(1);
  });

  it("falls back to Claude when OpenAI fails, and says so", async () => {
    demo.__LOGICA_DEMO_FAIL_OPENAI = true;
    await sendChatMessage("이 논문 핵심이 뭐야?");
    const message = answer();
    expect(message).toMatchObject({ status: "done", route: "answer", provider: "anthropic", model: "claude-sonnet-5-5", fallbackFrom: "gpt-6.1-sol" });
    expect(message.refined).toContain("핵심 아이디어");
  });

  it("shows the OpenAI error with a hint when Claude is not connected", async () => {
    demo.__LOGICA_DEMO_FAIL_OPENAI = true;
    await call("credential_delete", { provider: "anthropic" });
    try {
      await sendChatMessage("What does Table 2 report?");
      expect(answer().status).toBe("error");
      expect(answer().content).toContain("Anthropic API key");
    } finally {
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
