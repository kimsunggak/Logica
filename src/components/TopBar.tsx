import { Bot, Download, FilePlus, FileText, FolderOpen, House, Loader2, Play, Save, Settings } from "lucide-react";
import { PROVIDER_LABELS } from "../ai/providers/registry";
import { pickProjectFolder } from "../lib/backend";
import { closeProject, compileProject, exportPdf, openProject, saveAll } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { isConnected, isKnown, useConnections } from "../settings/connectionStore";
import { useSettings } from "../settings/settingsStore";
import { useWorkspace } from "../storage/workspaceStore";
import { LANGUAGES, useT } from "../i18n";
import type { ReactNode } from "react";
import { NewPaperMenu } from "./NewPaperMenu";
import { ProviderSelect } from "./ProviderSelect";
import { openSettings } from "./uiStore";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

export async function chooseAndOpenProject() {
  const folder = await pickProjectFolder();
  if (folder) await openProject(folder);
}

/**
 * A top bar button whose label gives way to the icon alone when the bar gets
 * narrow ("early" labels go first, then "late" ones; see the topbar container
 * rules in index.css). The label stays available as tooltip and aria-label.
 */
function BarButton({
  icon,
  label,
  collapse,
  title,
  active,
  testId,
  ...rest
}: {
  icon: ReactNode;
  label: string;
  collapse: "early" | "late";
  title: string;
  active?: boolean;
  testId?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className={`btn-ghost ${active ? "bg-slate-100 dark:bg-slate-800" : ""}`} title={title} aria-label={label} data-testid={testId} {...rest}>
      {icon}
      <span className="btn-label" data-collapse={collapse}>
        {label}
      </span>
    </button>
  );
}

/** Segmented 한국어 | English switch; the choice is saved with the settings. */
function LanguageToggle() {
  const t = useT();
  const language = useSettings((s) => s.ui.language);
  return (
    <div
      className="flex h-7 items-center rounded-md border border-slate-200 p-0.5 dark:border-slate-700"
      role="radiogroup"
      aria-label={t("top.language")}
      title={t("top.language")}
      data-testid="language-toggle"
    >
      {LANGUAGES.map((lang) => (
        <button
          key={lang.id}
          role="radio"
          aria-checked={language === lang.id}
          className={`h-full rounded px-[0.65em] text-[length:var(--ui-font)] font-medium whitespace-nowrap ${
            language === lang.id
              ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
              : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
          }`}
          onClick={() => useSettings.getState().updateUI({ language: lang.id })}
          data-testid={`language-${lang.id}`}
          aria-label={lang.label}
        >
          <span className="lang-full">{lang.label}</span>
          <span className="lang-short">{lang.short}</span>
        </button>
      ))}
    </div>
  );
}

export function TopBar() {
  const t = useT();
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
    <header className="topbar flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-2 dark:border-slate-800 dark:bg-[#0f141b]">
      <button
        className="mr-1.5 shrink-0 pl-1 text-[13px] font-bold tracking-[0.18em] text-slate-800 disabled:cursor-default dark:text-slate-100"
        onClick={() => void closeProject()}
        disabled={!root}
        title={root ? t("top.home") : undefined}
      >
        LOGICA
      </button>
      {root && (
        <>
          <BarButton
            icon={<House />}
            label={t("top.home")}
            collapse="early"
            title={t("top.home")}
            testId="go-home"
            onClick={() => void closeProject()}
          />
          <BarButton
            icon={<FolderOpen />}
            label={t("top.openProject")}
            collapse="early"
            title={t("top.openProjectTitle", { mod: MOD })}
            testId="open-project"
            onClick={() => void chooseAndOpenProject()}
          />
          <NewPaperMenu
            className="shrink-0"
            menuClassName="top-8 left-0 w-64"
            trigger={({ open, toggle }) => (
              <BarButton
                icon={<FilePlus />}
                label={t("top.newPaper")}
                collapse="early"
                title={t("top.newPaperTitle")}
                active={open}
                testId="new-paper"
                onClick={toggle}
              />
            )}
          />
          <span className="min-w-0 max-w-[220px] truncate px-1 text-[length:var(--ui-font)] text-slate-500" title={root}>
            {name}
          </span>
          <div className="mx-0.5 h-5 w-px shrink-0 bg-slate-200 dark:bg-slate-700" />
          <BarButton
            icon={<Save />}
            label={t("top.save")}
            collapse="late"
            title={t("top.saveTitle", { mod: MOD })}
            disabled={!anyDirty}
            onClick={() => void saveAll()}
          />
          <BarButton
            icon={compileStatus === "running" ? <Loader2 className="animate-spin" /> : <Play />}
            label={t("top.compile")}
            collapse="late"
            title={t("top.compileTitle", { mod: MOD })}
            disabled={compileStatus === "running"}
            testId="compile"
            onClick={() => void compileProject()}
          />
          <BarButton
            icon={<Download />}
            label={t("top.export")}
            collapse="late"
            title={t("top.exportTitle")}
            testId="export-pdf"
            onClick={() => void exportPdf()}
          />
        </>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <span
          className={`h-2 w-2 rounded-full ${isKnown(connection) && connected ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`}
          title={t(connected ? "top.connected" : "top.notConnected", { provider: PROVIDER_LABELS[provider] })}
        />
        <ProviderSelect
          value={provider}
          onChange={(p) => useSettings.getState().updateAI({ defaultProvider: p })}
          title={t("top.defaultProvider")}
          className="topbar-provider h-7"
        />
        <span className="hidden max-w-[150px] truncate text-[11.5px] text-slate-400 xl:inline" title={model}>
          {model}
        </span>
        {root && (
          <>
            <div className="mx-0.5 h-5 w-px shrink-0 bg-slate-200 dark:bg-slate-700" />
            <BarButton
              icon={<FileText />}
              label={t("top.pdf")}
              collapse="early"
              title={t("top.pdfTitle")}
              active={showPdf}
              onClick={() => toggle("showPdf")}
            />
            <BarButton
              icon={<Bot />}
              label={t("top.ai")}
              collapse="early"
              title={t("top.aiTitle", { mod: MOD })}
              active={showChat}
              testId="toggle-chat"
              onClick={() => toggle("showChat")}
            />
          </>
        )}
        <button className="btn-ghost" onClick={() => openSettings()} title={t("top.settingsTitle", { mod: MOD })} data-testid="open-settings">
          <Settings size={14} />
        </button>
        <LanguageToggle />
      </div>
    </header>
  );
}
