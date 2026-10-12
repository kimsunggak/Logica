import { useRef, useState } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { EditorPane } from "../editor/EditorPane";
import { PdfPreview } from "../pdf/PdfPreview";
import { useWorkspace, type LayoutState } from "../storage/workspaceStore";
import { ErrorBoundary } from "./ErrorBoundary";
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

/** Outline | Editor | PDF | AI chat. The editor always takes the remaining space. */
export function Workspace() {
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

  return (
    <div className="flex min-h-0 flex-1">
      <div className="shrink-0" style={{ width: effective.sidebarWidth }}>
        <ErrorBoundary name="outline">
          <Sidebar />
        </ErrorBoundary>
      </div>
      <ResizeHandle {...resizer("sidebarWidth", 1)} />
      <div className="min-w-[320px] flex-1">
        <ErrorBoundary name="editor">
          <EditorPane />
        </ErrorBoundary>
      </div>
      {effective.showPdf && (
        <>
          <ResizeHandle {...resizer("pdfWidth", -1)} />
          <div className="shrink-0" style={{ width: effective.pdfWidth }}>
            <ErrorBoundary name="PDF">
              <PdfPreview />
            </ErrorBoundary>
          </div>
        </>
      )}
      {effective.showChat && (
        <>
          <ResizeHandle {...resizer("chatWidth", -1)} />
          <div className="shrink-0" style={{ width: effective.chatWidth }}>
            <ErrorBoundary name="AI chat">
              <ChatPanel />
            </ErrorBoundary>
          </div>
        </>
      )}
    </div>
  );
}
