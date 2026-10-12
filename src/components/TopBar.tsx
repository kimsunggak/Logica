import { Bot, FileText, FolderOpen, Loader2, Play, Save, Settings } from "lucide-react";
import { PROVIDER_LABELS } from "../ai/providers/registry";
import { pickProjectFolder } from "../lib/backend";
import { compileProject, openProject, saveAll } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { isConnected, isKnown, useConnections } from "../settings/connectionStore";
import { useSettings } from "../settings/settingsStore";
import { useWorkspace } from "../storage/workspaceStore";
import { ProviderSelect } from "./ProviderSelect";
import { openSettings } from "./uiStore";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

export async function chooseAndOpenProject() {
  const folder = await pickProjectFolder();
  if (folder) await openProject(folder);
}

export function TopBar() {
  const root = useProject((s) => s.root);
  const name = useProject((s) => s.name);
  const compileStatus = useProject((s) => s.compile.status);
  const anyDirty = useProject((s) => s.openFiles.some((f) => f.dirty));
  const provider = useSettings((s) => s.ai.defaultProvider);
  const model = useSettings((s) => s.ai.models[provider]);
  const connection = useConnections((s) => s[provider]);
  const openaiAuth = useSettings((s) => s.ai.openaiAuth);
  const connected = isConnected(provider, connection, openaiAuth);
  const showPdf = useWorkspace((s) => s.layout.showPdf);
  const showChat = useWorkspace((s) => s.layout.showChat);
  const toggle = (key: "showPdf" | "showChat") => useWorkspace.getState().updateLayout({ [key]: !useWorkspace.getState().layout[key] });

  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-slate-200 bg-white px-2 dark:border-slate-800 dark:bg-[#0f141b]">
      <span className="mr-2 pl-1 text-[13px] font-bold tracking-[0.18em] text-slate-800 dark:text-slate-100">LOGICA</span>
      <button className="btn-ghost" onClick={() => void chooseAndOpenProject()} title={`Open project folder (${MOD}O)`} data-testid="open-project">
        <FolderOpen size={14} /> Open Project
      </button>
      {root && (
        <>
          <span className="max-w-[220px] truncate px-1 text-[12.5px] text-slate-500" title={root}>
            {name}
          </span>
          <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
          <button className="btn-ghost" onClick={() => void saveAll()} disabled={!anyDirty} title={`Save all (${MOD}Shift+S)`}>
            <Save size={14} /> Save
          </button>
          <button
            className="btn-ghost"
            onClick={() => void compileProject()}
            disabled={compileStatus === "running"}
            title={`Compile (${MOD}Enter)`}
            data-testid="compile"
          >
            {compileStatus === "running" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Compile
          </button>
        </>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full ${isKnown(connection) && connected ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}
          title={connected ? `${PROVIDER_LABELS[provider]} connected` : `${PROVIDER_LABELS[provider]} not connected`}
        />
        <ProviderSelect
          value={provider}
          onChange={(p) => useSettings.getState().updateAI({ defaultProvider: p })}
          title="Default AI provider"
          className="h-7"
        />
        <span className="hidden max-w-[150px] truncate text-[11.5px] text-slate-400 xl:inline" title={model}>
          {model}
        </span>
        <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
        <button className={`btn-ghost ${showPdf ? "bg-slate-100 dark:bg-slate-800" : ""}`} onClick={() => toggle("showPdf")} title="Show/hide PDF">
          <FileText size={14} /> PDF
        </button>
        <button
          className={`btn-ghost ${showChat ? "bg-slate-100 dark:bg-slate-800" : ""}`}
          onClick={() => toggle("showChat")}
          title={`Show/hide AI chat (${MOD}Shift+L)`}
          data-testid="toggle-chat"
        >
          <Bot size={14} /> AI
        </button>
        <button className="btn-ghost" onClick={() => openSettings()} title={`Settings (${MOD},)`} data-testid="open-settings">
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}
