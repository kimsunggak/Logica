import { Bot, ChevronsLeftRight, FileCode, FileText, ListTree, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ComponentType } from "react";
import { useT, type MessageKey } from "../i18n";
import { useWorkspace, type LayoutState } from "../storage/workspaceStore";

/**
 * Collapse / expand state of the workspace panels. The panel headers, the
 * collapsed strips and the left panel bar all read and write the same layout
 * flags, so they always agree.
 */
export type PaneId = "outline" | "editor" | "pdf" | "chat";

type PaneFlag = "showOutline" | "showEditor" | "showPdf" | "showChat";

interface PaneInfo {
  id: PaneId;
  flag: PaneFlag;
  label: MessageKey;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Side the panel collapses towards (picks the arrow icon). */
  side: "left" | "right";
}

export const PANES: PaneInfo[] = [
  {
    id: "outline",
    flag: "showOutline",
    label: "pane.outline",
    icon: ListTree,
    side: "left",
  },
  {
    id: "editor",
    flag: "showEditor",
    label: "pane.editor",
    icon: FileCode,
    side: "left",
  },
  {
    id: "pdf",
    flag: "showPdf",
    label: "pane.pdf",
    icon: FileText,
    side: "right",
  },
  {
    id: "chat",
    flag: "showChat",
    label: "pane.chat",
    icon: Bot,
    side: "right",
  },
];

const byId = (id: PaneId) => PANES.find((p) => p.id === id)!;

export function isPaneOpen(layout: LayoutState, id: PaneId): boolean {
  return layout[byId(id).flag];
}

export function setPaneOpen(id: PaneId, open: boolean) {
  useWorkspace.getState().updateLayout({ [byId(id).flag]: open });
}

export function togglePane(id: PaneId) {
  setPaneOpen(id, !isPaneOpen(useWorkspace.getState().layout, id));
}

export function expandAllPanes() {
  useWorkspace.getState().updateLayout({
    showOutline: true,
    showEditor: true,
    showPdf: true,
    showChat: true,
  });
}

/** Collapse button placed in a panel's own header. */
export function CollapseButton({ pane, className }: { pane: PaneId; className?: string }) {
  const t = useT();
  const info = byId(pane);
  const Icon = info.side === "left" ? PanelLeftClose : PanelRightClose;
  return (
    <button
      className={`icon-btn ${className ?? ""}`}
      title={t("pane.collapse", { pane: t(info.label) })}
      aria-label={t("pane.collapse", { pane: t(info.label) })}
      onClick={() => setPaneOpen(pane, false)}
      data-testid={`pane-collapse-${pane}`}
    >
      <Icon size={14} />
    </button>
  );
}

/** What a collapsed panel leaves behind: a narrow strip that expands it again. */
export function CollapsedStrip({ pane }: { pane: PaneId }) {
  const t = useT();
  const info = byId(pane);
  const Icon = info.side === "left" ? PanelLeftOpen : PanelRightOpen;
  const label = t(info.label);
  return (
    <button
      className={`group flex h-full w-7 shrink-0 flex-col items-center gap-2 ${info.side === "left" ? "border-r" : "border-l"} border-slate-200 bg-slate-50 pt-2 text-slate-500 hover:bg-sky-50 hover:text-sky-700 dark:border-slate-800 dark:bg-[#121820] dark:text-slate-400 dark:hover:bg-sky-950/40 dark:hover:text-sky-300`}
      title={t("pane.expand", { pane: label })}
      aria-label={t("pane.expand", { pane: label })}
      aria-expanded={false}
      onClick={() => setPaneOpen(pane, true)}
      data-testid={`pane-strip-${pane}`}
    >
      <Icon size={14} />
      <span className="text-[11.5px] font-medium tracking-wide [writing-mode:vertical-rl]">{label}</span>
    </button>
  );
}

/** Left bar listing every panel; each item collapses or expands its panel. */
export function PaneBar() {
  const t = useT();
  const layout = useWorkspace((s) => s.layout);
  const allOpen = PANES.every((p) => layout[p.flag]);
  return (
    <nav
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-slate-200 bg-slate-100/80 py-2 dark:border-slate-800 dark:bg-[#0c1117]"
      aria-label={t("pane.bar")}
      data-testid="pane-bar"
    >
      {PANES.map((pane) => {
        const open = layout[pane.flag];
        const label = t(pane.label);
        const Icon = pane.icon;
        return (
          <button
            key={pane.id}
            className={`relative flex h-9 w-9 items-center justify-center rounded-md ${
              open
                ? "bg-white text-sky-700 shadow-sm dark:bg-slate-800 dark:text-sky-300"
                : "text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            }`}
            title={t(open ? "pane.collapse" : "pane.expand", { pane: label })}
            aria-label={label}
            aria-pressed={open}
            onClick={() => togglePane(pane.id)}
            data-testid={`pane-toggle-${pane.id}`}
          >
            {open && <span className="absolute inset-y-1.5 -left-1 w-0.5 rounded bg-sky-600 dark:bg-sky-400" />}
            <Icon size={16} />
          </button>
        );
      })}
      <div className="my-1 h-px w-6 bg-slate-200 dark:bg-slate-700" />
      <button
        className="flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title={t("pane.expandAll")}
        aria-label={t("pane.expandAll")}
        disabled={allOpen}
        onClick={expandAllPanes}
        data-testid="pane-expand-all"
      >
        <ChevronsLeftRight size={16} />
      </button>
    </nav>
  );
}
