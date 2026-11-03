import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { findSection, type PaperSection } from "../latex/parser/documentModel";
import { navigateTo, navigateToSection } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { useT } from "../i18n";
import { useWorkspace } from "../storage/workspaceStore";

function SectionNode({
  section,
  depth,
  collapsed,
  activeTrail,
  currentId,
  onToggle,
}: {
  section: PaperSection;
  depth: number;
  collapsed: Set<string>;
  activeTrail: Set<string>;
  currentId: string | null;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const isCollapsed = collapsed.has(section.id);
  const isCurrent = section.id === currentId;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ block: "nearest" });
  }, [isCurrent]);

  return (
    <div>
      <div
        ref={ref}
        data-testid="outline-item"
        data-current={isCurrent || undefined}
        className={`group flex h-[26px] cursor-pointer items-center gap-1 rounded pr-2 text-[12.5px] ${
          isCurrent
            ? "bg-sky-100 font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-100"
            : activeTrail.has(section.id)
              ? "text-slate-900 dark:text-slate-100"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"
        }`}
        style={{ paddingLeft: 4 + depth * 14 }}
        title={`${section.filePath}:${section.startLine}`}
        onClick={() => void navigateToSection(section)}
      >
        {section.children.length > 0 ? (
          <button
            className="icon-btn h-5 w-5 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(section.id);
            }}
            aria-label={t(isCollapsed ? "outline.expand" : "outline.collapse")}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {section.number && <span className="shrink-0 tabular-nums text-slate-400">{section.number}</span>}
        <span className="truncate">{section.title}</span>
        {section.wordCount > 0 && (
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-slate-400 tabular-nums" title={t("outline.words")}>
            {section.wordCount}
          </span>
        )}
      </div>
      {!isCollapsed &&
        section.children.map((child) => (
          <SectionNode
            key={child.id}
            section={child}
            depth={depth + 1}
            collapsed={collapsed}
            activeTrail={activeTrail}
            currentId={currentId}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

export function OutlinePanel() {
  const t = useT();
  const doc = useProject((s) => s.doc);
  const root = useProject((s) => s.root);
  const currentId = useProject((s) => s.currentSectionId);
  const collapsedIds = useWorkspace((s) => (root ? s.projects[root]?.collapsed : undefined));
  const collapsed = useMemo(() => new Set(collapsedIds ?? []), [collapsedIds]);

  const current = doc && currentId ? findSection(doc, currentId) : undefined;
  const activeTrail = useMemo(() => {
    const trail = new Set<string>();
    let id = current?.parentId;
    while (id && doc) {
      trail.add(id);
      id = findSection(doc, id)?.parentId;
    }
    return trail;
  }, [current, doc]);

  // Reveal the current section when the cursor moves into a collapsed branch
  // (only on cursor movement, so collapsing a parent by hand still works).
  useEffect(() => {
    if (!root || activeTrail.size === 0) return;
    const ids = useWorkspace.getState().project(root).collapsed;
    if (ids.some((id) => activeTrail.has(id))) {
      useWorkspace.getState().setCollapsed(root, ids.filter((id) => !activeTrail.has(id)));
    }
  }, [currentId]);

  if (!doc) return null;
  const toggle = (id: string) => root && useWorkspace.getState().toggleCollapsed(root, id);
  const withChildren = doc.flatSections.filter((s) => s.children.length > 0).map((s) => s.id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pt-2 pb-1">
        <span className="panel-title">{t("outline.paper")}</span>
        <button className="icon-btn ml-auto" title={t("outline.expandAll")} onClick={() => root && useWorkspace.getState().setCollapsed(root, [])}>
          <ChevronsUpDown size={13} />
        </button>
        <button className="icon-btn" title={t("outline.collapseAll")} onClick={() => root && useWorkspace.getState().setCollapsed(root, withChildren)}>
          <ChevronsDownUp size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-testid="outline">
        {doc.title && (
          <div className="truncate px-2 pb-1 text-[12.5px] font-semibold text-slate-800 dark:text-slate-100" title={doc.title}>
            {doc.title}
          </div>
        )}
        {doc.abstractLocation && (
          <div
            className="flex h-[26px] cursor-pointer items-center rounded pr-2 pl-[28px] text-[12.5px] text-slate-600 italic hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"
            onClick={() => void navigateTo(doc.abstractLocation!.filePath, doc.abstractLocation!.line)}
          >
            {t("outline.abstract")}
          </div>
        )}
        {doc.sections.map((section) => (
          <SectionNode
            key={section.id}
            section={section}
            depth={0}
            collapsed={collapsed}
            activeTrail={activeTrail}
            currentId={currentId}
            onToggle={toggle}
          />
        ))}
        {doc.flatSections.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-slate-400">
            {t(doc.mainFile ? "outline.noSections" : "outline.noMain")}
          </div>
        )}
      </div>
      {current && (
        <div className="border-t border-slate-200 px-3 py-1.5 text-[11.5px] text-slate-500 dark:border-slate-800 dark:text-slate-400" data-testid="outline-location">
          <div className="truncate">
            {current.number ? `${current.number} ` : ""}
            {current.title}
          </div>
          <div className="truncate font-mono text-[11px]">
            {current.filePath}:{current.startLine}
            {current.endLine ? `–${current.endLine}` : ""}
          </div>
        </div>
      )}
      {doc.issues.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-t border-slate-200 px-3 py-1.5 dark:border-slate-800">
          {doc.issues.map((issue, i) => (
            <div
              key={i}
              className={`flex gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300 ${issue.filePath && issue.line ? "cursor-pointer hover:underline" : ""}`}
              onClick={() => issue.filePath && issue.line && void navigateTo(issue.filePath, issue.line)}
            >
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
