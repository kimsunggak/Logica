import { useRef, useState, type CSSProperties } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { EditorPane } from "../editor/EditorPane";
import { PdfPreview } from "../pdf/PdfPreview";
import { useWorkspace, type LayoutState } from "../storage/workspaceStore";
import { useT } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import { CollapsedStrip, expandAllPanes, PaneBar, type PaneId } from "./panes";
import { ResizeHandle } from "./ResizeHandle";
import { Sidebar } from "./Sidebar";

const LIMITS = {
  sidebarWidth: [180, 480],
  pdfWidth: [260, 1000],
  chatWidth: [280, 640],
} as const;

type Resizable = keyof typeof LIMITS;

function clamp(key: Resizable, value: number) {
  const [min, max] = LIMITS[key];
  return Math.round(Math.max(min, Math.min(max, value)));
}

/**
 * Outline | Editor | PDF | AI chat. Each panel can be collapsed to a strip.
 * The editor takes the remaining space; when it is collapsed the open side
 * panels share that space (in proportion to their widths), and when only the
 * outline is left, it fills the window.
 */
export function Workspace() {
  const t = useT();
  const layout = useWorkspace((s) => s.layout);
  const [draft, setDraft] = useState<Partial<LayoutState>>({});
  const start = useRef<LayoutState>(layout);
  const effective = { ...layout, ...draft };

  const resizer = (key: Resizable, direction: 1 | -1) => ({
    onResize: (delta: number) => {
      if (Object.keys(draft).length === 0) start.current = layout;
      setDraft({ [key]: clamp(key, start.current[key] + direction * delta) });
    },
    onResizeEnd: () => {
      useWorkspace.getState().updateLayout(draft);
      setDraft({});
    },
  });

  const open = {
    outline: effective.showOutline,
    editor: effective.showEditor,
    pdf: effective.showPdf,
    chat: effective.showChat,
  };
  // Which open panels absorb the free space.
  const fill: Set<PaneId> = open.editor
    ? new Set(["editor"])
    : open.pdf || open.chat
      ? new Set((["pdf", "chat"] as const).filter((id) => open[id]))
      : open.outline
        ? new Set(["outline"])
        : new Set();
  const sizeOf = (id: PaneId, width: number): CSSProperties =>
    fill.has(id) ? { flex: `${width} 1 0`, minWidth: id === "editor" ? 320 : 200 } : { width, flexShrink: 0 };

  return (
    <div className="flex min-h-0 flex-1">
      <PaneBar />

      {open.outline ? (
        <>
          <div style={sizeOf("outline", effective.sidebarWidth)}>
            <ErrorBoundary name="outline">
              <Sidebar />
            </ErrorBoundary>
          </div>
          {!fill.has("outline") && <ResizeHandle {...resizer("sidebarWidth", 1)} />}
        </>
      ) : (
        <CollapsedStrip pane="outline" />
      )}

      {/* The editor stays mounted while collapsed so its view and undo history survive. */}
      <div className={open.editor ? "min-w-0" : "hidden"} style={open.editor ? sizeOf("editor", 1) : undefined}>
        <ErrorBoundary name="editor">
          <EditorPane />
        </ErrorBoundary>
      </div>
      {!open.editor && <CollapsedStrip pane="editor" />}

      {fill.size === 0 && (
        <div className="flex flex-1 items-center justify-center p-6" data-testid="all-collapsed">
          <div className="max-w-xs text-center text-[12.5px] text-slate-400">
            <p>{t("pane.allCollapsed")}</p>
            <button className="btn mt-3" onClick={expandAllPanes}>
              {t("pane.expandAll")}
            </button>
          </div>
        </div>
      )}

      {open.pdf &&
        (fill.has("pdf") ? <div className="w-px shrink-0 bg-slate-200 dark:bg-slate-800" /> : <ResizeHandle {...resizer("pdfWidth", -1)} />)}
      {/* Kept mounted while collapsed: the rendered pages and zoom come back instantly. */}
      <div className={open.pdf ? "" : "hidden"} style={open.pdf ? sizeOf("pdf", effective.pdfWidth) : undefined}>
        <ErrorBoundary name="PDF">
          <PdfPreview />
        </ErrorBoundary>
      </div>
      {!open.pdf && <CollapsedStrip pane="pdf" />}

      {open.chat ? (
        <>
          {fill.has("chat") ? <div className="w-px shrink-0 bg-slate-200 dark:bg-slate-800" /> : <ResizeHandle {...resizer("chatWidth", -1)} />}
          <div style={sizeOf("chat", effective.chatWidth)}>
            <ErrorBoundary name="AI chat">
              <ChatPanel />
            </ErrorBoundary>
          </div>
        </>
      ) : (
        <CollapsedStrip pane="chat" />
      )}
    </div>
  );
}
