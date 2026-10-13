import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./workspaceStore";

afterEach(() => {
  vi.useRealTimers();
  useWorkspace.setState({ projects: {}, lastProject: undefined });
});

describe("recent projects", () => {
  it("records when a project was opened and forgets it on request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    useWorkspace.getState().setLastProject("/a");
    vi.setSystemTime(2000);
    useWorkspace.getState().setLastProject("/b");
    expect(useWorkspace.getState().projects["/a"].lastOpened).toBe(1000);
    expect(useWorkspace.getState().lastProject).toBe("/b");
    useWorkspace.getState().forgetProject("/b");
    expect(Object.keys(useWorkspace.getState().projects)).toEqual(["/a"]);
    expect(useWorkspace.getState().lastProject).toBeUndefined();
  });

  it("drops the least recently opened project beyond the limit", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(1000 + i);
      useWorkspace.getState().setLastProject(`/p${i}`);
    }
    vi.setSystemTime(5000);
    useWorkspace.getState().setLastProject("/p0"); // reopened, so it is recent again
    vi.setSystemTime(6000);
    useWorkspace.getState().setLastProject("/p21");
    const roots = Object.keys(useWorkspace.getState().projects);
    expect(roots).toHaveLength(20);
    expect(roots).toContain("/p0");
    expect(roots).not.toContain("/p1");
    expect(roots).not.toContain("/p2");
  });
});
