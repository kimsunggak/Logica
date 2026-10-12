import { X } from "lucide-react";
import { dismissNotice, useProject } from "../project/projectStore";

export function Notices() {
  const notices = useProject((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-8 z-40 flex w-[360px] flex-col gap-2">
      {notices.map((n) => (
        <div
          key={n.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] shadow-lg ${
            n.kind === "error"
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
              : n.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                : "border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          }`}
        >
          <span className="flex-1">{n.text}</span>
          <button className="icon-btn h-5 w-5" onClick={() => dismissNotice(n.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
