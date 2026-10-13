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
}

export interface LayoutState {
  sidebarWidth: number;
  pdfWidth: number;
  chatWidth: number;
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
  pdfWidth: 440,
  chatWidth: 360,
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
      const projects = { ...s.projects, [root]: s.projects[root] ?? EMPTY_PROJECT };
      const keys = Object.keys(projects);
      if (keys.length > MAX_REMEMBERED_PROJECTS) delete projects[keys[0]];
      return { lastProject: root, projects };
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
    layout: { ...DEFAULT_LAYOUT, ...(w.layout ?? {}) },
  };
}
