import { afterEach, describe, expect, it, vi } from "vitest";
import * as trace from "../debug/trace";
import { newChatSession, useChat } from "./chatStore";

const initial = useChat.getState();

afterEach(() => {
  useChat.setState(initial);
  vi.restoreAllMocks();
});

describe("saved-session inspection context", () => {
  it("follows session selection, project changes and returning home", () => {
    const sync = vi.spyOn(trace, "setDebugProject").mockImplementation(() => {});
    useChat.setState({ root: "/paper-a", sessionId: "session-a" });
    expect(sync).toHaveBeenLastCalledWith("/paper-a", "session-a");
    useChat.setState({ sessionId: "older-session" });
    expect(sync).toHaveBeenLastCalledWith("/paper-a", "older-session");
    useChat.setState({ root: "/paper-b", sessionId: "session-b" });
    expect(sync).toHaveBeenLastCalledWith("/paper-b", "session-b");
    useChat.setState({ root: null });
    expect(sync).toHaveBeenLastCalledWith(null, "session-b");
  });

  it("points to the new conversation before its first message is saved", () => {
    const sync = vi.spyOn(trace, "setDebugProject").mockImplementation(() => {});
    useChat.setState({ root: "/paper-a", sessionId: "previous", messages: [] });
    newChatSession();
    const id = useChat.getState().sessionId;
    expect(id).not.toBe("previous");
    expect(sync).toHaveBeenLastCalledWith("/paper-a", id);
    sync.mockClear();
    useChat.setState({ sessions: [] });
    expect(sync).not.toHaveBeenCalled();
  });
});
