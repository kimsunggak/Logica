/**
 * Workspace state remembered between sessions: last project, open files,
 * cursor positions, outline collapse state and panel layout.
 */
import { create } from "zustand";

export interface CursorMemory {
  anchor: number;
  head: number;
}

export interface ProjectMemory {
  mainFile?: string;
  activeFile?: string;
  openFiles: string[];
  cursors: Record<string, CursorMemory>;
  /** Ids of collapsed outline sections. */
  collapsed: string[];
  /** Paper title from \\title{...}, shown on the home screen. */
  title?: string;
  /** When the project was last opened (ms since epoch). */
  lastOpened?: number;
}

export interface LayoutState {
  sidebarWidth: number;
  /** Shares of the free width (flex-grow) for the editor, preview and chat. */
  editorWeight: number;
  pdfWeight: number;
  chatWeight: number;
  /** Expanded (true) or collapsed to a strip (false), per panel. */
  showOutline: boolean;
  showEditor: boolean;
  showPdf: boolean;
  showChat: boolean;
  sidebarTab: "outline" | "files";
}

export interface WorkspaceData {
  lastProject?: string;
  projects: Record<string, ProjectMemory>;
  layout: LayoutState;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarWidth: 260,
  // Preview and chat start 50:50 when both are open.
  editorWeight: 0.4,
  pdfWeight: 0.3,
  chatWeight: 0.3,
  showOutline: true,
  showEditor: true,
  showPdf: true,
  showChat: false,
  sidebarTab: "outline",
};

const EMPTY_PROJECT: ProjectMemory = { openFiles: [], cursors: {}, collapsed: [] };
const MAX_REMEMBERED_PROJECTS = 20;

interface WorkspaceStore extends WorkspaceData {
  setLastProject(root: string): void;
  /** Remove a project from the recent list (its files are untouched). */
  forgetProject(root: string): void;
  project(root: string): ProjectMemory;
  updateProject(root: string, patch: Partial<ProjectMemory>): void;
  setCursor(root: string, path: string, cursor: CursorMemory): void;
  toggleCollapsed(root: string, sectionId: string): void;
  setCollapsed(root: string, ids: string[]): void;
  updateLayout(patch: Partial<LayoutState>): void;
  replaceAll(data: WorkspaceData): void;
}

export const useWorkspace = create<WorkspaceStore>()((set, get) => ({
  projects: {},
  layout: DEFAULT_LAYOUT,
  setLastProject: (root) =>
    set((s) => {
      const projects = { ...s.projects, [root]: { ...(s.projects[root] ?? EMPTY_PROJECT), lastOpened: Date.now() } };
      const byAge = Object.keys(projects).sort((a, b) => (projects[a].lastOpened ?? 0) - (projects[b].lastOpened ?? 0));
      for (const key of byAge.slice(0, Math.max(0, byAge.length - MAX_REMEMBERED_PROJECTS))) delete projects[key];
      return { lastProject: root, projects };
    }),
  forgetProject: (root) =>
    set((s) => {
      const { [root]: _removed, ...projects } = s.projects;
      return { projects, lastProject: s.lastProject === root ? undefined : s.lastProject };
    }),
  project: (root) => get().projects[root] ?? EMPTY_PROJECT,
  updateProject: (root, patch) =>
    set((s) => ({ projects: { ...s.projects, [root]: { ...(s.projects[root] ?? EMPTY_PROJECT), ...patch } } })),
  setCursor: (root, path, cursor) =>
    set((s) => {
      const project = s.projects[root] ?? EMPTY_PROJECT;
      return { projects: { ...s.projects, [root]: { ...project, cursors: { ...project.cursors, [path]: cursor } } } };
    }),
  toggleCollapsed: (root, sectionId) =>
    set((s) => {
      const project = s.projects[root] ?? EMPTY_PROJECT;
      const collapsed = project.collapsed.includes(sectionId)
        ? project.collapsed.filter((id) => id !== sectionId)
        : [...project.collapsed, sectionId];
      return { projects: { ...s.projects, [root]: { ...project, collapsed } } };
    }),
  setCollapsed: (root, ids) =>
    set((s) => ({ projects: { ...s.projects, [root]: { ...(s.projects[root] ?? EMPTY_PROJECT), collapsed: ids } } })),
  updateLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
  replaceAll: (data) => set(data),
}));

export function currentWorkspace(): WorkspaceData {
  const { lastProject, projects, layout } = useWorkspace.getState();
  return { lastProject, projects, layout };
}

/** Saved layout over the defaults; unknown (retired) keys and invalid sizes are dropped. */
function mergeLayout(saved: unknown): LayoutState {
  const layout: LayoutState = { ...DEFAULT_LAYOUT };
  if (!saved || typeof saved !== "object") return layout;
  for (const key of Object.keys(DEFAULT_LAYOUT) as (keyof LayoutState)[]) {
    const value = (saved as Record<string, unknown>)[key];
    const fallback = DEFAULT_LAYOUT[key];
    const valid = typeof fallback === "number" ? typeof value === "number" && Number.isFinite(value) && value > 0 : typeof value === typeof fallback;
    if (valid) (layout as unknown as Record<string, unknown>)[key] = value;
  }
  return layout;
}

export function mergeWorkspace(saved: unknown): WorkspaceData {
  const w = (saved && typeof saved === "object" ? saved : {}) as Partial<WorkspaceData>;
  const projects: Record<string, ProjectMemory> = {};
  for (const [root, p] of Object.entries(w.projects ?? {})) {
    projects[root] = {
      ...EMPTY_PROJECT,
      ...p,
      openFiles: Array.isArray(p?.openFiles) ? p.openFiles : [],
      cursors: p?.cursors ?? {},
      collapsed: Array.isArray(p?.collapsed) ? p.collapsed : [],
    };
  }
  return {
    lastProject: typeof w.lastProject === "string" ? w.lastProject : undefined,
    projects,
    layout: mergeLayout(w.layout),
  };
}
