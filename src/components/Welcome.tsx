import { FolderOpen } from "lucide-react";
import { isDemoMode } from "../lib/backend";
import { useProject } from "../project/projectStore";
import { useT } from "../i18n";
import { chooseAndOpenProject } from "./TopBar";

export function Welcome() {
  const t = useT();
  const loading = useProject((s) => s.loading);
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md text-center">
        <h1 className="text-[22px] font-bold tracking-[0.2em]">LOGICA</h1>
        <p className="mt-2 text-[13px] text-slate-500">{t("welcome.tagline")}</p>
        <button className="btn-primary mt-6 h-9 px-4 text-[13px]" onClick={() => void chooseAndOpenProject()} disabled={loading}>
          <FolderOpen size={15} /> {loading ? t("welcome.opening") : t("welcome.open")}
        </button>
        <p className="mt-4 text-[12px] text-slate-400">
          {t("welcome.hint")}
        </p>
        {isDemoMode() && (
          <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t("welcome.demo")}
          </p>
        )}
      </div>
    </div>
  );
}
