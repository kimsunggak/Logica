import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./projectApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./projectApi")>()),
  listProjectFiles: vi.fn(async () => {
    throw { kind: "not_found", message: "Project folder not found: os error 2" };
  }),
}));

import { useWorkspace } from "../storage/workspaceStore";
import { openProject } from "./projectActions";
import { useProject } from "./projectStore";

describe("opening a project whose folder is gone", () => {
  beforeEach(() => {
    useWorkspace.getState().replaceAll({ projects: {}, layout: useWorkspace.getState().layout });
    useWorkspace.getState().setLastProject("/gone");
  });

  it("drops it from recent work and explains why", async () => {
    await openProject("/gone");
    expect(useWorkspace.getState().projects["/gone"]).toBeUndefined();
    expect(useWorkspace.getState().lastProject).toBeUndefined();
    const notices = useProject.getState().notices;
    expect(notices.at(-1)?.text).toContain("removed from recent work");
    expect(useProject.getState().loading).toBe(false);
  });
});
