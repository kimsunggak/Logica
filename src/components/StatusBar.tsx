import { findSection } from "../latex/parser/documentModel";
import { useT } from "../i18n";
import { useProject } from "../project/projectStore";

export function StatusBar() {
  const t = useT();
  const activePath = useProject((s) => s.activePath);
  const cursor = useProject((s) => s.cursor);
  const doc = useProject((s) => s.doc);
  const currentSectionId = useProject((s) => s.currentSectionId);
  const dirty = useProject((s) => s.openFiles.find((f) => f.path === s.activePath)?.dirty);
  const section = doc && currentSectionId ? findSection(doc, currentSectionId) : undefined;

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-slate-200 bg-slate-50 px-3 text-[11.5px] text-slate-500 dark:border-slate-800 dark:bg-[#121820] dark:text-slate-400">
      {activePath ? (
        <>
          <span className="truncate" title={activePath}>
            {activePath}
            {dirty ? ` • ${t("status.unsaved")}` : ""}
          </span>
          {section && (
            <span className="truncate">
              § {section.number ? `${section.number} ` : ""}
              {section.title}
            </span>
          )}
          <span className="ml-auto whitespace-nowrap">
            {t("status.position", { line: cursor.line, column: cursor.column })}
            {cursor.selectionLength > 0 ? ` ${t("status.selected", { count: cursor.selectionLength })}` : ""}
          </span>
        </>
      ) : (
        <span className="ml-auto" />
      )}
      {doc && doc.wordCount > 0 && <span className="whitespace-nowrap">{t("status.words", { count: doc.wordCount.toLocaleString() })}</span>}
    </div>
  );
}
