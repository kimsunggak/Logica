import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readBinaryFile } from "../project/projectApi";
import { pdfjs } from "./pdfjs";

/** First page of a compiled PDF, rendered small; a placeholder when there is none. */
export function PdfThumbnail({ root, pdfPath, width }: { root: string; pdfPath: string | null; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    setRendered(false);
    if (!pdfPath) return;
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    (async () => {
      try {
        const bytes = await readBinaryFile(root, pdfPath);
        if (cancelled) return;
        task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: (width * ratio) / page.getViewport({ scale: 1 }).width });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, viewport }).promise;
        if (!cancelled) setRendered(true);
      } catch {
        // Unreadable or missing PDF: keep the placeholder.
      } finally {
        void task?.destroy();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, pdfPath, width]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      <canvas ref={canvasRef} className={`w-full ${rendered ? "" : "hidden"}`} />
      {!rendered && (
        <div className="flex h-full items-center justify-center text-slate-300">
          <FileText size={36} strokeWidth={1.2} />
        </div>
      )}
    </div>
  );
}
