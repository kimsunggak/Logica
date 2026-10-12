import { Loader2, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
// The legacy build ships polyfills for recent JS built-ins that older system
// webviews (e.g. WKWebView on older macOS, WebKitGTK) do not have yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/backend";
import { readBinaryFile } from "../project/projectApi";
import { useProject } from "../project/projectStore";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface LoadedPdf {
  task: PDFDocumentLoadingTask;
  doc: PDFDocumentProxy;
  pages: PDFPageProxy[];
}

function PdfPage({ page, scale }: { page: PDFPageProxy; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const viewport = page.getViewport({ scale });

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    let task: RenderTask | null = page.render({ canvas, viewport: vp });
    task.promise.catch(() => {
      // Cancelled or failed renders leave the placeholder in place.
    });
    return () => {
      task?.cancel();
      task = null;
    };
  }, [page, scale, visible]);

  return (
    <div ref={holderRef} className="pdf-page mx-auto mb-3 bg-white" style={{ width: viewport.width, height: viewport.height }}>
      <canvas ref={canvasRef} style={{ width: viewport.width, height: viewport.height, display: "block" }} />
    </div>
  );
}

export function PdfPreview() {
  const root = useProject((s) => s.root);
  const pdfPath = useProject((s) => s.compile.pdfPath);
  const version = useProject((s) => s.compile.pdfVersion);
  const status = useProject((s) => s.compile.status);
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [width, setWidth] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!root || !pdfPath) {
      setPdf(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bytes = await readBinaryFile(root, pdfPath);
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        const doc = await task.promise;
        const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
        if (cancelled) {
          void task.destroy();
          return;
        }
        setError(null);
        setPdf((previous) => {
          if (previous) void previous.task.destroy();
          return { task, doc, pages };
        });
      } catch (err) {
        if (!cancelled) setError(`Could not load the PDF: ${errorMessage(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, pdfPath, version]);

  const baseWidth = pdf?.pages[0]?.getViewport({ scale: 1 }).width ?? 612;
  const fitScale = Math.max(0.2, (width - 24) / baseWidth);
  const scale = zoom === "fit" ? fitScale : zoom;
  const setScale = (value: number) => setZoom(Math.max(0.3, Math.min(4, Math.round(value * 10) / 10)));

  return (
    <div className="flex h-full flex-col bg-slate-100 dark:bg-[#0b0f14]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 dark:border-slate-800 dark:bg-[#121820]">
        <span className="panel-title">PDF</span>
        {status === "running" && (
          <span className="ml-2 flex items-center gap-1 text-[11.5px] text-slate-500">
            <Loader2 size={12} className="animate-spin" /> Compiling…
          </span>
        )}
        {pdf && <span className="ml-2 text-[11.5px] text-slate-400">{pdf.doc.numPages} pages</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <button className="icon-btn" title="Zoom out" onClick={() => setScale(scale - 0.1)} disabled={!pdf}>
            <ZoomOut size={13} />
          </button>
          <span className="w-10 text-center text-[11px] text-slate-500 tabular-nums">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" title="Zoom in" onClick={() => setScale(scale + 0.1)} disabled={!pdf}>
            <ZoomIn size={13} />
          </button>
          <button className="icon-btn" title="Fit width" onClick={() => setZoom("fit")} disabled={!pdf}>
            <Maximize2 size={12} />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3" data-testid="pdf-preview">
        {error && <div className="text-[12px] text-red-600">{error}</div>}
        {!pdf && !error && (
          <div className="mt-10 text-center text-[12px] text-slate-400">
            {status === "running" ? "Compiling…" : "No PDF yet. Press Compile to build the paper."}
          </div>
        )}
        {pdf?.pages.map((page) => <PdfPage key={page.pageNumber} page={page} scale={scale} />)}
      </div>
    </div>
  );
}
