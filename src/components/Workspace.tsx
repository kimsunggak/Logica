import { useRef, useState, type CSSProperties } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { EditorPane } from "../editor/EditorPane";
import { PdfPreview } from "../pdf/PdfPreview";
import { useWorkspace, type LayoutState } from "../storage/workspaceStore";
import { useT } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import { CollapsedStrip, expandAllPanes, PaneBar } from "./panes";
import { ResizeHandle } from "./ResizeHandle";
import { Sidebar } from "./Sidebar";
import { equalPair, resizePair } from "./splitLayout";

const SIDEBAR_LIMITS = [160, 480] as const;

/** Panes that share the free width by weight, in screen order. */
type SplitPane = "editor" | "pdf" | "chat";
const SPLIT_PANES: SplitPane[] = ["editor", "pdf", "chat"];
const WEIGHT_KEY = { editor: "editorWeight", pdf: "pdfWeight", chat: "chatWeight" } as const;
const MIN_WIDTH: Record<SplitPane | "outline", number> = { outline: 160, editor: 280, pdf: 220, chat: 240 };

/**
 * Outline | Editor | Preview | AI chat. Each panel can be collapsed to a strip.
 * The outline is a sidebar of fixed width; the open editor, preview and chat
 * divide the rest by weight, so they always fit side by side without
 * overlapping. Dragging a border moves width between the two panes it
 * separates; double-clicking it splits them 50:50. When only the outline is
 * left, it fills the window.
 */
export function Workspace() {
  const t = useT();
  const layout = useWorkspace((s) => s.layout);
  const [draft, setDraft] = useState<Partial<LayoutState>>({});
  const effective = { ...layout, ...draft };
  const paneRefs = useRef<Partial<Record<SplitPane, HTMLDivElement | null>>>({});
  const dragStart = useRef<{ px: [number, number]; weights: [number, number]; sidebar: number } | null>(null);

  const open = {
    outline: effective.showOutline,
    editor: effective.showEditor,
    pdf: effective.showPdf,
    chat: effective.showChat,
  };
  const openSplit = SPLIT_PANES.filter((id) => open[id]);
  const weight = (id: SplitPane) => effective[WEIGHT_KEY[id]];
  // Normalised so the open panes' flex-grow sums to 1: below 1, flex would leave part of the width empty.
  const openWeight = openSplit.reduce((sum, id) => sum + weight(id), 0) || 1;
  const splitStyle = (id: SplitPane): CSSProperties => ({ flex: `${weight(id) / openWeight} 1 0px`, minWidth: MIN_WIDTH[id] });

  const commit = () => {
    if (Object.keys(draft).length) useWorkspace.getState().updateLayout(draft);
    setDraft({});
    dragStart.current = null;
  };

  /** Border between two neighbouring weighted panes. */
  const splitHandle = (a: SplitPane, b: SplitPane) => (
    <ResizeHandle
      key={`${a}-${b}`}
      testId={`split-${a}-${b}`}
      title={t("pane.splitHint")}
      onResize={(delta) => {
        if (!dragStart.current) {
          const pxA = paneRefs.current[a]?.getBoundingClientRect().width ?? 0;
          const pxB = paneRefs.current[b]?.getBoundingClientRect().width ?? 0;
          dragStart.current = { px: [pxA, pxB], weights: [weight(a), weight(b)], sidebar: 0 };
        }
        const start = dragStart.current;
        const [wa, wb] = resizePair(start.px, start.weights, delta, [MIN_WIDTH[a], MIN_WIDTH[b]]);
        setDraft({ [WEIGHT_KEY[a]]: wa, [WEIGHT_KEY[b]]: wb });
      }}
      onResizeEnd={commit}
      onDoubleClick={() => {
        const [wa, wb] = equalPair([layout[WEIGHT_KEY[a]], layout[WEIGHT_KEY[b]]]);
        useWorkspace.getState().updateLayout({ [WEIGHT_KEY[a]]: wa, [WEIGHT_KEY[b]]: wb });
      }}
    />
  );

  const sidebarHandle = (
    <ResizeHandle
      testId="split-outline"
      onResize={(delta) => {
        if (!dragStart.current) dragStart.current = { px: [0, 0], weights: [0, 0], sidebar: layout.sidebarWidth };
        const [min, max] = SIDEBAR_LIMITS;
        setDraft({ sidebarWidth: Math.round(Math.max(min, Math.min(max, dragStart.current.sidebar + delta))) });
      }}
      onResizeEnd={commit}
    />
  );

  /** Separator before a weighted pane: a drag handle when an open weighted pane is directly before it. */
  const before = (id: SplitPane) => {
    const index = openSplit.indexOf(id);
    return index > 0 ? splitHandle(openSplit[index - 1], id) : null;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <PaneBar />

      {open.outline ? (
        <>
          <div
            className="min-w-0"
            style={openSplit.length ? { width: effective.sidebarWidth, flexShrink: 0, minWidth: MIN_WIDTH.outline } : { flex: "1 1 0px" }}
          >
            <ErrorBoundary name="outline">
              <Sidebar />
            </ErrorBoundary>
          </div>
          {openSplit.length > 0 && sidebarHandle}
        </>
      ) : (
        <CollapsedStrip pane="outline" />
      )}

      {/* The editor stays mounted while collapsed so its view and undo history survive. */}
      <div
        ref={(el) => {
          paneRefs.current.editor = el;
        }}
        className={open.editor ? "min-w-0 overflow-hidden" : "hidden"}
        style={open.editor ? splitStyle("editor") : undefined}
      >
        <ErrorBoundary name="editor">
          <EditorPane />
        </ErrorBoundary>
      </div>
      {!open.editor && <CollapsedStrip pane="editor" />}

      {!open.outline && openSplit.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-6" data-testid="all-collapsed">
          <div className="max-w-xs text-center text-[12.5px] text-slate-400">
            <p>{t("pane.allCollapsed")}</p>
            <button className="btn mt-3" onClick={expandAllPanes}>
              {t("pane.expandAll")}
            </button>
          </div>
        </div>
      )}

      {open.pdf && before("pdf")}
      {/* Kept mounted while collapsed: the rendered pages and zoom come back instantly. */}
      <div
        ref={(el) => {
          paneRefs.current.pdf = el;
        }}
        className={open.pdf ? "min-w-0 overflow-hidden" : "hidden"}
        style={open.pdf ? splitStyle("pdf") : undefined}
      >
        <ErrorBoundary name="PDF">
          <PdfPreview />
        </ErrorBoundary>
      </div>
      {!open.pdf && <CollapsedStrip pane="pdf" />}

      {open.chat ? (
        <>
          {before("chat")}
          <div
            ref={(el) => {
              paneRefs.current.chat = el;
            }}
            className="min-w-0 overflow-hidden"
            style={splitStyle("chat")}
          >
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
