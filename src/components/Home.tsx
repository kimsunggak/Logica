import { Clock, FilePlus, FolderOpen, Pencil, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import logo from "../assets/logo.png";
import { t as translateNow, useT } from "../i18n";
import { confirmDialog, errorKind, isDemoMode } from "../lib/backend";
import { timeAgo } from "../lib/time";
import type { MathFieldProps } from "../home/background/MathField";
import { PdfThumbnail } from "../pdf/PdfThumbnail";
import { openProject } from "../project/projectActions";
import { pathExists } from "../project/projectApi";
import { useProject } from "../project/projectStore";
import { useWorkspace, type ProjectMemory } from "../storage/workspaceStore";
import { NewPaperMenu } from "./NewPaperMenu";
import { chooseAndOpenProject } from "./TopBar";

const THUMB_WIDTH = 220;

// Loaded after the home screen is up so the WebGL code never delays it. A failed load
// only costs the decoration, never the home screen.
const MathField = lazy<ComponentType<MathFieldProps>>(() =>
  import("../home/background/MathField").catch(() => ({ default: () => null })),
);

function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

const RECHECK_MS = 5000;

/** Counter that ticks when the window regains focus and every few seconds while visible,
 *  so the cards notice folders deleted or moved outside the app. */
function useRecheckTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    const timer = window.setInterval(bump, RECHECK_MS);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", bump);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", bump);
    };
  }, []);
  return tick;
}

/** Whether the main file still exists, and the compiled PDF to preview (if any).
 *  A project whose folder is gone is dropped from the recent list. */
function useProjectFiles(root: string, memory: ProjectMemory, tick: number) {
  const [state, setState] = useState<{ missing: boolean; pdfPath: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const main = memory.mainFile ?? "main.tex";
    const pdf = main.replace(/\.tex$/, ".pdf");
    (async () => {
      try {
        const [hasMain, hasPdf] = await Promise.all([pathExists(root, main), pathExists(root, pdf)]);
        if (cancelled) return;
        const pdfPath = hasPdf ? pdf : null;
        setState((prev) => (prev && prev.missing === !hasMain && prev.pdfPath === pdfPath ? prev : { missing: !hasMain, pdfPath }));
      } catch (err) {
        if (cancelled) return;
        if (errorKind(err) === "not_found") useWorkspace.getState().forgetProject(root);
        else setState({ missing: true, pdfPath: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, memory.mainFile, tick]);
  return state;
}

async function removeFromList(root: string, name: string) {
  if (await confirmDialog(translateNow("home.removeConfirm", { name }))) useWorkspace.getState().forgetProject(root);
}

function displayName(root: string, memory: ProjectMemory): string {
  return memory.name || memory.title || folderName(root);
}

/** Inline editor for the card's name; Enter or leaving the field saves, Escape cancels. */
function NameEditor({ root, memory, onDone }: { root: string; memory: ProjectMemory; onDone: () => void }) {
  const t = useT();
  const [value, setValue] = useState(displayName(root, memory));
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save) {
      const name = value.trim();
      // A name equal to the paper title is not a custom name; keep following the title.
      useWorkspace.getState().updateProject(root, { name: name && name !== memory.title ? name : undefined });
    }
    onDone();
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      className="relative z-10 w-full rounded border border-sky-400 bg-white px-1.5 py-0.5 text-[13px] font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-sky-300 dark:border-sky-600 dark:bg-slate-900 dark:text-slate-100"
      value={value}
      placeholder={memory.title || folderName(root)}
      title={t("home.renameHint")}
      aria-label={t("home.rename")}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      data-testid="recent-name-input"
    />
  );
}

function ProjectCard({ root, memory, tick }: { root: string; memory: ProjectMemory; tick: number }) {
  const t = useT();
  const files = useProjectFiles(root, memory, tick);
  const missing = files?.missing ?? false;
  const [editing, setEditing] = useState(false);
  const name = displayName(root, memory);
  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md dark:border-slate-700 dark:bg-[#151c26] dark:hover:border-sky-700 ${
        missing ? "opacity-60" : ""
      }`}
      data-testid="recent-project"
    >
      {/* Covers the whole card so any click opens it; the name controls sit above it. */}
      <button
        className="absolute inset-0 z-0"
        onClick={() => void openProject(root)}
        disabled={missing || editing}
        title={root}
        aria-label={name}
      />
      <div className="pointer-events-none h-40 w-full border-b border-slate-100 bg-slate-100 dark:border-slate-800 dark:bg-slate-900">
        <PdfThumbnail root={root} pdfPath={files?.pdfPath ?? null} width={THUMB_WIDTH} />
      </div>
      <div className="pointer-events-none space-y-0.5 px-3 py-2.5">
        {editing ? (
          <div className="pointer-events-auto">
            <NameEditor root={root} memory={memory} onDone={() => setEditing(false)} />
          </div>
        ) : (
          <div className="flex items-start gap-1">
            <div className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-semibold text-slate-800 dark:text-slate-100" data-testid="recent-name">
              {name}
            </div>
            <button
              className="pointer-events-auto relative z-10 -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-sky-600 dark:hover:bg-slate-800"
              title={t("home.rename")}
              aria-label={t("home.rename")}
              onClick={() => setEditing(true)}
              data-testid="recent-rename"
            >
              <Pencil size={12} />
            </button>
          </div>
        )}
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
      <button
        className="absolute top-1.5 right-1.5 z-10 hidden h-6 w-6 items-center justify-center rounded-md bg-white/90 text-slate-500 shadow-sm group-hover:flex hover:text-red-600 dark:bg-slate-800/90"
        title={t("home.remove")}
        aria-label={t("home.remove")}
        onClick={() => void removeFromList(root, name)}
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
  const tick = useRecheckTick();
  const recent = Object.entries(projects).sort(([, a], [, b]) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  return (
    // The background colors match LIGHT_THEME / DARK_THEME in home/background/renderer.ts.
    <div className="relative min-h-0 flex-1 bg-[#f8fafc] dark:bg-[#0c1117]" data-testid="home">
      <Suspense fallback={null}>
        <MathField interactionRef={scrollRef} columnRef={columnRef} />
      </Suspense>
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
        <div ref={columnRef} className="mx-auto max-w-5xl px-8 py-10">
          <h1>
            <img src={logo} alt="LOGICA" className="h-20 w-20 select-none" draggable={false} data-testid="home-logo" />
          </h1>

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <NewPaperMenu
              menuClassName="top-full left-0 mt-1 w-full"
              trigger={({ open, toggle }) => (
                <button
                  className="flex w-full items-center gap-3 rounded-lg border border-sky-600 bg-sky-600 px-4 py-3.5 text-left text-white shadow-sm hover:bg-sky-700 disabled:opacity-60"
                  onClick={toggle}
                  disabled={loading}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  data-testid="home-new"
                >
                  <FilePlus size={22} />
                  <span>
                    <span className="block text-[14px] font-semibold">{t("home.new")}</span>
                    <span className="block text-[12px] text-sky-100">{t("home.newHint")}</span>
                  </span>
                </button>
              )}
            />
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
            <div className="rounded-lg border border-dashed border-slate-300 bg-[#f8fafc]/85 px-6 py-10 text-center text-[13px] text-slate-500 dark:border-slate-700 dark:bg-[#0c1117]/85">
              {t("home.empty")}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4" data-testid="recent-projects">
              {recent.map(([root, memory]) => (
                <ProjectCard key={root} root={root} memory={memory} tick={tick} />
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
    </div>
  );
}
