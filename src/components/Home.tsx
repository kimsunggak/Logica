import { Clock, FilePlus, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { currentLanguage, t as translateNow, useT } from "../i18n";
import { confirmDialog, isDemoMode } from "../lib/backend";
import { PdfThumbnail } from "../pdf/PdfThumbnail";
import { newPaper, openProject } from "../project/projectActions";
import { pathExists } from "../project/projectApi";
import { useProject } from "../project/projectStore";
import { useWorkspace, type ProjectMemory } from "../storage/workspaceStore";
import { chooseAndOpenProject } from "./TopBar";

const THUMB_WIDTH = 220;

function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function timeAgo(ms: number | undefined): string {
  if (!ms) return "";
  const rtf = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "auto" });
  const seconds = Math.round((ms - Date.now()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return translateNow("home.justNow");
}

/** Whether the folder still exists, and the compiled PDF to preview (if any). */
function useProjectFiles(root: string, memory: ProjectMemory) {
  const [state, setState] = useState<{ missing: boolean; pdfPath: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const main = memory.mainFile ?? "main.tex";
    const pdf = main.replace(/\.tex$/, ".pdf");
    (async () => {
      try {
        const [hasMain, hasPdf] = await Promise.all([pathExists(root, main), pathExists(root, pdf)]);
        if (!cancelled) setState({ missing: !hasMain, pdfPath: hasPdf ? pdf : null });
      } catch {
        if (!cancelled) setState({ missing: true, pdfPath: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, memory.mainFile]);
  return state;
}

async function removeFromList(root: string, name: string) {
  if (await confirmDialog(translateNow("home.removeConfirm", { name }))) useWorkspace.getState().forgetProject(root);
}

function ProjectCard({ root, memory }: { root: string; memory: ProjectMemory }) {
  const t = useT();
  const files = useProjectFiles(root, memory);
  const missing = files?.missing ?? false;
  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md dark:border-slate-700 dark:bg-[#151c26] dark:hover:border-sky-700 ${
        missing ? "opacity-60" : ""
      }`}
      data-testid="recent-project"
    >
      <button className="flex flex-1 flex-col text-left" onClick={() => void openProject(root)} disabled={missing} title={root}>
        <div className="h-40 w-full border-b border-slate-100 bg-slate-100 dark:border-slate-800 dark:bg-slate-900">
          <PdfThumbnail root={root} pdfPath={files?.pdfPath ?? null} width={THUMB_WIDTH} />
        </div>
        <div className="space-y-0.5 px-3 py-2.5">
          <div className="line-clamp-2 text-[13px] leading-snug font-semibold text-slate-800 dark:text-slate-100">
            {memory.title || folderName(root)}
          </div>
          <div className="truncate font-mono text-[11px] text-slate-400">{root}</div>
          <div className="flex items-center gap-1 pt-0.5 text-[11.5px] text-slate-500">
            {missing ? (
              <span className="text-amber-600">{t("home.missing")}</span>
            ) : (
              <>
                <Clock size={11} /> {timeAgo(memory.lastOpened)}
              </>
            )}
          </div>
        </div>
      </button>
      <button
        className="absolute top-1.5 right-1.5 hidden h-6 w-6 items-center justify-center rounded-md bg-white/90 text-slate-500 shadow-sm group-hover:flex hover:text-red-600 dark:bg-slate-800/90"
        title={t("home.remove")}
        aria-label={t("home.remove")}
        onClick={() => void removeFromList(root, memory.title || folderName(root))}
        data-testid="recent-remove"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Main screen: start a paper, open a folder, or continue recent work. */
export function Home() {
  const t = useT();
  const loading = useProject((s) => s.loading);
  const projects = useWorkspace((s) => s.projects);
  const recent = Object.entries(projects).sort(([, a], [, b]) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-[#0c1117]" data-testid="home">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <h1 className="text-[22px] font-bold tracking-[0.2em]">LOGICA</h1>
        <p className="mt-1 text-[13px] text-slate-500">{t("welcome.tagline")}</p>

        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <button
            className="flex items-center gap-3 rounded-lg border border-sky-600 bg-sky-600 px-4 py-3.5 text-left text-white shadow-sm hover:bg-sky-700 disabled:opacity-60"
            onClick={() => void newPaper()}
            disabled={loading}
            data-testid="home-new"
          >
            <FilePlus size={22} />
            <span>
              <span className="block text-[14px] font-semibold">{t("home.new")}</span>
              <span className="block text-[12px] text-sky-100">{t("home.newHint")}</span>
            </span>
          </button>
          <button
            className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3.5 text-left shadow-sm hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-[#151c26] dark:hover:bg-slate-800"
            onClick={() => void chooseAndOpenProject()}
            disabled={loading}
            data-testid="home-open"
          >
            <FolderOpen size={22} className="text-slate-500" />
            <span>
              <span className="block text-[14px] font-semibold">{t("home.open")}</span>
              <span className="block text-[12px] text-slate-500">{t("home.openHint")}</span>
            </span>
          </button>
        </div>

        <h2 className="mt-10 mb-3 text-[13px] font-semibold tracking-wide text-slate-600 dark:text-slate-300">{t("home.recent")}</h2>
        {recent.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center text-[13px] text-slate-500 dark:border-slate-700">
            {t("home.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4" data-testid="recent-projects">
            {recent.map(([root, memory]) => (
              <ProjectCard key={root} root={root} memory={memory} />
            ))}
          </div>
        )}

        {isDemoMode() && (
          <p className="mt-8 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t("welcome.demo")}
          </p>
        )}
      </div>
    </div>
  );
}
