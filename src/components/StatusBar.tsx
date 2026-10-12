import { findSection } from "../latex/parser/documentModel";
import { useProject } from "../project/projectStore";

export function StatusBar() {
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
            {dirty ? " • unsaved" : ""}
          </span>
          {section && (
            <span className="truncate">
              § {section.number ? `${section.number} ` : ""}
              {section.title}
            </span>
          )}
          <span className="ml-auto whitespace-nowrap">
            Ln {cursor.line}, Col {cursor.column}
            {cursor.selectionLength > 0 ? ` (${cursor.selectionLength} selected)` : ""}
          </span>
        </>
      ) : (
        <span className="ml-auto" />
      )}
      {doc && doc.wordCount > 0 && <span className="whitespace-nowrap">{doc.wordCount.toLocaleString()} words</span>}
    </div>
  );
}
