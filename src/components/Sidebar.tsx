import { OutlinePanel } from "../outline/OutlinePanel";
import { FileExplorer } from "../project/FileExplorer";
import { useT } from "../i18n";
import { useWorkspace } from "../storage/workspaceStore";
import { CollapseButton } from "./panes";

export function Sidebar() {
  const t = useT();
  const tab = useWorkspace((s) => s.layout.sidebarTab);
  const setTab = (sidebarTab: "outline" | "files") => useWorkspace.getState().updateLayout({ sidebarTab });
  return (
    <div className="flex h-full flex-col bg-slate-50/70 dark:bg-[#121820]">
      <div className="flex h-8 shrink-0 items-end gap-1 border-b border-slate-200 px-2 dark:border-slate-800">
        {(["outline", "files"] as const).map((id) => (
          <button
            key={id}
            className={`h-7 border-b-2 px-2 text-[12px] font-medium ${
              tab === id
                ? "border-sky-600 text-slate-900 dark:text-slate-100"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
            onClick={() => setTab(id)}
          >
            {t(id === "outline" ? "sidebar.outline" : "sidebar.files")}
          </button>
        ))}
        <CollapseButton pane="outline" className="mb-0.5 ml-auto" />
      </div>
      <div className="min-h-0 flex-1">{tab === "outline" ? <OutlinePanel /> : <FileExplorer />}</div>
    </div>
  );
}
