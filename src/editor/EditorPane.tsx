import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { AlertTriangle, FileText, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { closeFile, openFile, resolveExternalChange } from "../project/projectActions";
import { useProject } from "../project/projectStore";
import { CompileLog } from "../components/CompileLog";
import { StatusBar } from "../components/StatusBar";
import { editorSession } from "./editorSession";
import { InlineEditPanel } from "./inlineEdit/InlineEditPanel";

function EditorTabs() {
  const openFiles = useProject((s) => s.openFiles);
  const activePath = useProject((s) => s.activePath);
  const mainFile = useProject((s) => s.mainFile);
  if (openFiles.length === 0) return null;
  return (
    <div className="flex h-8 shrink-0 items-end overflow-x-auto border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-[#121820]" role="tablist">
      {openFiles.map((file) => {
        const active = file.path === activePath;
        const name = file.path.split("/").pop();
        return (
          <div
            key={file.path}
            role="tab"
            aria-selected={active}
            title={file.path}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void closeFile(file.path);
              }
            }}
            onClick={() => void openFile(file.path)}
            className={`group flex h-full cursor-pointer items-center gap-1.5 border-r border-slate-200 px-3 text-[12.5px] dark:border-slate-800 ${
              active
                ? "bg-white text-slate-900 dark:bg-[#0f141b] dark:text-slate-100"
                : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/60"
            }`}
          >
            <FileText size={12} className={file.path === mainFile ? "text-sky-600 dark:text-sky-400" : "opacity-60"} />
            <span className="whitespace-nowrap">{name}</span>
            {file.dirty ? (
              <span className="ml-0.5 h-2 w-2 rounded-full bg-slate-500 dark:bg-slate-300" title="Unsaved changes" data-testid="dirty-dot" />
            ) : (
              <span className="ml-0.5 w-2" />
            )}
            <button
              className="icon-btn -mr-1 h-5 w-5 opacity-0 group-hover:opacity-100"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                void closeFile(file.path);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ExternalChangeBanner() {
  const activePath = useProject((s) => s.activePath);
  const meta = useProject((s) => s.openFiles.find((f) => f.path === s.activePath));
  if (!activePath || !meta?.external) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
      <AlertTriangle size={14} />
      {meta.external === "deleted" ? (
        <span>This file was deleted on disk. Saving will recreate it.</span>
      ) : (
        <>
          <span>This file changed on disk and you have unsaved edits.</span>
          <button className="btn h-6" onClick={() => void resolveExternalChange(activePath, "reload")}>
            Load disk version
          </button>
          <button className="btn h-6" onClick={() => void resolveExternalChange(activePath, "keep")}>
            Keep my version
          </button>
        </>
      )}
    </div>
  );
}

export function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const activePath = useProject((s) => s.activePath);

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: EditorState.create({ doc: "" }) });
    editorSession.attach(view);
    return () => {
      editorSession.detach();
      view.destroy();
    };
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <EditorTabs />
      <ExternalChangeBanner />
      <div ref={areaRef} className="relative min-h-0 flex-1">
        <div ref={hostRef} className={`absolute inset-0 ${activePath ? "" : "invisible"}`} data-testid="editor-host" />
        {!activePath && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-slate-400">
            Select a section in the outline or a file to start writing.
          </div>
        )}
        <InlineEditPanel container={areaRef} />
      </div>
      <CompileLog />
      <StatusBar />
    </div>
  );
}
