import { Loader2, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { t as translateNow, useT } from "../i18n";
import { errorMessage } from "../lib/backend";
import { readBinaryFile } from "../project/projectApi";
import { pdfjs } from "./pdfjs";
import { useProject } from "../project/projectStore";
import { CollapseButton } from "../components/panes";

interface LoadedPdf {
  task: PDFDocumentLoadingTask;
  doc: PDFDocumentProxy;
  pages: PDFPageProxy[];
}

function PdfPage({ page, scale }: { page: PDFPageProxy; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
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

  // Transparent text over the canvas so the paper's text can be selected and copied.
  useEffect(() => {
    const container = textRef.current;
    if (!visible || !container) return;
    container.replaceChildren();
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale }) });
    layer.render().catch(() => {
      // Cancelled (zoom or scroll) or a page without text: nothing to select.
    });
    return () => layer.cancel();
  }, [page, scale, visible]);

  return (
    <div
      ref={holderRef}
      className="pdf-page relative mx-auto mb-4 bg-white"
      style={{ width: viewport.width, height: viewport.height, ["--total-scale-factor" as string]: scale }}
    >
      <canvas ref={canvasRef} style={{ width: viewport.width, height: viewport.height, display: "block" }} />
      <div ref={textRef} className="textLayer" data-testid="pdf-text-layer" />
    </div>
  );
}

export function PdfPreview() {
  const root = useProject((s) => s.root);
  const t = useT();
  const pdfPath = useProject((s) => s.compile.pdfPath);
  const version = useProject((s) => s.compile.pdfVersion);
  const status = useProject((s) => s.compile.status);
  const compileError = useProject((s) => s.compile.error);
  // A first compilation may download packages; explain the wait if it is long.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (status !== "running") return;
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, [status]);
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [width, setWidth] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A collapsed panel reports width 0; keep the last real width for its return.
    const observer = new ResizeObserver(([entry]) => entry.contentRect.width > 0 && setWidth(entry.contentRect.width));
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
        if (!cancelled) setError(translateNow("pdf.loadError", { error: errorMessage(err) }));
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

  // Only the paper is shown; zoom and collapse float over it in a small bar.
  return (
    <div className="relative h-full bg-slate-200/70 dark:bg-[#0b0f14]">
      <div
        className="absolute top-2 right-3 z-10 flex items-center gap-0.5 rounded-md border border-slate-200 bg-white/90 px-1 py-0.5 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/90"
        data-testid="pdf-toolbar"
      >
        {status === "running" && (
          <span className="flex items-center px-1 text-sky-600" title={t("pdf.compiling")} data-testid="pdf-compiling">
            <Loader2 size={12} className="animate-spin" />
          </span>
        )}
        {pdf && <span className="px-1 text-[11px] text-slate-400 tabular-nums">{t("pdf.pages", { count: pdf.doc.numPages })}</span>}
        <button className="icon-btn h-6 w-6" title={t("pdf.zoomOut")} onClick={() => setScale(scale - 0.1)} disabled={!pdf}>
          <ZoomOut size={13} />
        </button>
        <span className="w-9 text-center text-[11px] text-slate-500 tabular-nums">{Math.round(scale * 100)}%</span>
        <button className="icon-btn h-6 w-6" title={t("pdf.zoomIn")} onClick={() => setScale(scale + 0.1)} disabled={!pdf}>
          <ZoomIn size={13} />
        </button>
        <button className="icon-btn h-6 w-6" title={t("pdf.fit")} onClick={() => setZoom("fit")} disabled={!pdf}>
          <Maximize2 size={12} />
        </button>
        <div className="mx-0.5 h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <CollapseButton pane="pdf" className="h-6 w-6" />
      </div>
      <div ref={scrollRef} className="h-full overflow-auto px-3 pt-11 pb-3" data-testid="pdf-preview">
        {error && <div className="text-[12px] text-red-600">{error}</div>}
        {!pdf && !error && (
          <div className="mt-10 text-center text-[12px] text-slate-500">
            {status === "running"
              ? slow
                ? `${t("pdf.compiling")} ${t("pdf.firstCompile")}`
                : t("pdf.compiling")
              : compileError
                ? compileError
                : status === "failed"
                  ? t("pdf.failed")
                  : t("pdf.empty")}
          </div>
        )}
        {pdf?.pages.map((page) => <PdfPage key={page.pageNumber} page={page} scale={scale} />)}
      </div>
    </div>
  );
}
