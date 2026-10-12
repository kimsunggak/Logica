import { FolderOpen } from "lucide-react";
import { isDemoMode } from "../lib/backend";
import { useProject } from "../project/projectStore";
import { chooseAndOpenProject } from "./TopBar";

export function Welcome() {
  const loading = useProject((s) => s.loading);
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md text-center">
        <h1 className="text-[22px] font-bold tracking-[0.2em]">LOGICA</h1>
        <p className="mt-2 text-[13px] text-slate-500">Researcher writes. AI edits on demand.</p>
        <button className="btn-primary mt-6 h-9 px-4 text-[13px]" onClick={() => void chooseAndOpenProject()} disabled={loading}>
          <FolderOpen size={15} /> {loading ? "Opening…" : "Open a LaTeX project folder"}
        </button>
        <p className="mt-4 text-[12px] text-slate-400">
          LOGICA reads main.tex, follows \input and \include, and builds the paper outline.
        </p>
        {isDemoMode() && (
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Browser preview mode: files, compilation and AI responses are simulated. Run <code>npm run tauri dev</code> for the desktop app.
          </p>
        )}
      </div>
    </div>
  );
}
