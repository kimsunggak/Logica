import { useRef } from "react";

interface ResizeHandleProps {
  /** Called with the horizontal drag distance since the drag started. */
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

/** Vertical drag handle between panels. */
export function ResizeHandle({ onResize, onResizeEnd }: ResizeHandleProps) {
  const startX = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-slate-200 dark:bg-slate-800"
      onPointerDown={(e) => {
        startX.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        onResize(e.clientX - startX.current);
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.style.userSelect = "";
        onResizeEnd?.();
      }}
    >
      <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-sky-500/30" />
    </div>
  );
}
