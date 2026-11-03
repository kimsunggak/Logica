import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { newPaper } from "../project/projectActions";
import { PAPER_TEMPLATES } from "../project/templates";

/**
 * A "New paper" button (rendered by `trigger`) that opens a menu of paper
 * templates; picking one creates the paper. Outside click or Escape closes it.
 */
export function NewPaperMenu({
  trigger,
  className,
  menuClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  className?: string;
  menuClassName: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className ?? ""}`}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          role="menu"
          className={`absolute z-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-[#151c26] ${menuClassName}`}
          data-testid="new-paper-menu"
        >
          {PAPER_TEMPLATES.map((template) => (
            <button
              key={template.id}
              role="menuitem"
              className="block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
              onClick={() => {
                setOpen(false);
                void newPaper(template.id);
              }}
              data-testid={`new-paper-${template.id}`}
            >
              <span className="block text-[13px] font-medium text-slate-800 dark:text-slate-100">{t(template.label)}</span>
              <span className="block text-[11.5px] text-slate-500">{t(template.hint)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
