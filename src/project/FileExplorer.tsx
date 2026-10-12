import { BookOpen, FileText, Folder, RefreshCw, Star } from "lucide-react";
import { useMemo } from "react";
import { openFile, refreshFileList, setMainFile } from "./projectActions";
import { useProject } from "./projectStore";

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  isFile: boolean;
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], isFile: false };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.isFile === isFile);
      if (!child) {
        child = { name: part, path: childPath, children: [], isFile };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

export function FileExplorer() {
  const entries = useProject((s) => s.entries);
  const activePath = useProject((s) => s.activePath);
  const mainFile = useProject((s) => s.mainFile);
  const doc = useProject((s) => s.doc);
  const openFiles = useProject((s) => s.openFiles);
  const tree = useMemo(() => buildTree(entries.map((e) => e.path)), [entries]);
  const included = useMemo(() => new Set(doc?.files.filter((f) => f.included).map((f) => f.path)), [doc]);
  const dirty = useMemo(() => new Set(openFiles.filter((f) => f.dirty).map((f) => f.path)), [openFiles]);

  const renderNode = (node: TreeNode, depth: number) => {
    if (!node.isFile) {
      return (
        <div key={node.path}>
          <div className="flex h-[24px] items-center gap-1.5 text-[12.5px] text-slate-500 dark:text-slate-400" style={{ paddingLeft: 8 + depth * 14 }}>
            <Folder size={13} />
            {node.name}
          </div>
          {node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    const isTex = node.path.endsWith(".tex");
    const isMain = node.path === mainFile;
    return (
      <div
        key={node.path}
        className={`group flex h-[24px] cursor-pointer items-center gap-1.5 rounded pr-1 text-[12.5px] ${
          node.path === activePath
            ? "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100"
            : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70"
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => void openFile(node.path)}
        title={node.path}
      >
        {node.path.endsWith(".bib") ? <BookOpen size={13} className="shrink-0 opacity-70" /> : <FileText size={13} className="shrink-0 opacity-70" />}
        <span className={`truncate ${isTex && !included.has(node.path) ? "opacity-60" : ""}`}>{node.name}</span>
        {dirty.has(node.path) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />}
        {isMain && <span className="ml-1 rounded bg-sky-600/10 px-1 text-[10px] font-semibold text-sky-700 dark:text-sky-300">MAIN</span>}
        {isTex && !isMain && (
          <button
            className="icon-btn ml-auto h-5 w-5 opacity-0 group-hover:opacity-100"
            title="Set as main file"
            onClick={(e) => {
              e.stopPropagation();
              setMainFile(node.path);
            }}
          >
            <Star size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center px-3 pt-2 pb-1">
        <span className="panel-title">Files</span>
        <button className="icon-btn ml-auto" title="Refresh" onClick={() => void refreshFileList()}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-testid="file-explorer">
        {tree.map((n) => renderNode(n, 0))}
        {entries.length === 0 && <div className="px-2 py-3 text-[12px] text-slate-400">No .tex or .bib files in this folder.</div>}
      </div>
    </div>
  );
}
