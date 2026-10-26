import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_MODELS } from "../ai/models/modelConfig";
import { useProject } from "../project/projectStore";
import { loadSession, saveSession } from "./chatHistory";
import { runChatTurn, type Turn, type TurnResult } from "./orchestrator";
import { sendChatMessage, setChatMode, switchChatSession, useChat } from "./chatStore";
import { preparePaperEdits } from "./paper/editTool";

vi.mock("./orchestrator", async (original) => ({ ...(await original<object>()), runChatTurn: vi.fn() }));
vi.mock("./chatHistory", async (original) => ({
  ...(await original<object>()), saveSession: vi.fn(async () => {}), loadSession: vi.fn(),
}));
const choice = CHAT_MODELS.answer.primary;
const finished = (turn: Turn): TurnResult => ({
  route: turn.mode === "edit" ? "edit" : "chat", outcome: turn.mode === "edit" ? "edit" : "chat",
  content: "Done", choice, finishReason: "stop",
  ...(turn.mode === "edit" ? { edits: [{ path: "main.tex", original: "Original", revised: "Revised" }], editToolCallId: "tool-1" } : {}),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runChatTurn).mockReset().mockImplementation(async (turn) => finished(turn));
  vi.mocked(saveSession).mockClear();
  vi.mocked(loadSession).mockReset();
  useProject.setState({ root: null });
  useChat.setState({ root: "/project", sessionId: "session-1", messages: [], runningId: null, summary: null, mode: "auto", sessions: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("UI modes and persisted editing proposals", () => {
  it.each(["chat", "edit", "auto"] as const)("freezes %s in the sent turn and both messages", async (mode) => {
    setChatMode(mode);
    await sendChatMessage("Request");
    expect(vi.mocked(runChatTurn).mock.calls[0][0].mode).toBe(mode);
    expect(useChat.getState().messages.map((m) => m.mode)).toEqual([mode, mode]);
  });

  it("keeps an in-flight turn's mode when the next composer mode changes", async () => {
    let finish!: (value: TurnResult) => void;
    vi.mocked(runChatTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    setChatMode("edit");
    const sending = sendChatMessage("Shorten method");
    setChatMode("chat");
    finish(finished({ id: "turn", instruction: "Shorten method", mode: "edit", turns: [] }));
    await sending;
    expect(useChat.getState().mode).toBe("chat");
    expect(useChat.getState().messages.at(-1)).toMatchObject({ mode: "edit", route: "edit", editToolCallId: "tool-1" });
  });

  it("saves composer mode and structured tool edits", async () => {
    setChatMode("edit");
    await sendChatMessage("Shorten method");
    await vi.advanceTimersByTimeAsync(550);
    expect(saveSession).toHaveBeenCalledWith("/project", "session-1", expect.objectContaining({
      mode: "edit",
      messages: expect.arrayContaining([expect.objectContaining({ mode: "edit", edits: [{ path: "main.tex", original: "Original", revised: "Revised" }], editToolCallId: "tool-1" })]),
    }));
  });

  it("loads modes and tool proposals, and defaults an older session to Auto", async () => {
    const message = { id: "answer", role: "assistant" as const, content: "Proposal", status: "done" as const, mode: "edit" as const, route: "edit" as const, edits: [{ path: "main.tex", original: "Old", revised: "New" }], editToolCallId: "tool-1" };
    vi.mocked(loadSession).mockResolvedValue({ version: 2, createdAt: 1, updatedAt: 2, mode: "edit", messages: [message] });
    await switchChatSession("saved");
    expect(useChat.getState()).toMatchObject({ mode: "edit", messages: [message] });
    vi.mocked(loadSession).mockResolvedValue({ version: 1, createdAt: 1, updatedAt: 2, messages: [] });
    await switchChatSession("legacy");
    expect(useChat.getState().mode).toBe("auto");
  });

  it("normalizes saved CRLF proposals without changing message metadata, statuses or ordinary spaces", async () => {
    const message = {
      id: "answer", role: "assistant" as const, content: "Proposal description.\r\nKeep this text.", status: "done" as const,
      mode: "edit" as const, route: "edit" as const, editToolCallId: "existing-call", provider: "openai" as const, model: "gpt-6.1-sol",
      instruction: "Keep the spacing.", refined: "Rewrite the two sentences with their spacing preserved.",
      edits: [
        { path: "main.tex", original: "First  sentence.\r\nSecond sentence.\rThird sentence.", revised: "Revised  first.\r\nRevised second.\rRevised third." },
        { path: "other.tex", original: "Previously\r\napplied.", revised: "Already\r\napplied." },
      ],
      editStates: { 1: "applied" as const },
    };
    vi.mocked(loadSession).mockResolvedValue({ version: 2, createdAt: 10, updatedAt: 20, mode: "edit", messages: [message] });
    await switchChatSession("saved-crlf");
    const loaded = useChat.getState().messages[0];
    expect(loaded).toEqual({
      ...message,
      edits: [
        { path: "main.tex", original: "First  sentence.\nSecond sentence.\nThird sentence.", revised: "Revised  first.\nRevised second.\nRevised third." },
        { path: "other.tex", original: "Previously\napplied.", revised: "Already\napplied." },
      ],
    });
    expect(useChat.getState()).toMatchObject({ mode: "edit", sessionId: "saved-crlf", createdAt: 10 });
    const edit = loaded.edits![0];
    expect(preparePaperEdits([edit], new Map([["main.tex", "First  sentence.\nSecond sentence.\nThird sentence."]]))).not.toBeNull();
    expect(preparePaperEdits([edit], new Map([["main.tex", "First sentence.\nSecond sentence.\nThird sentence."]]))).toBeNull();
    expect(message.edits[0].original).toContain("\r\n");
  });
});
