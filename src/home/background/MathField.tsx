import { useEffect, useRef, useState, type RefObject } from "react";
import { loadAtlas } from "./atlas";
import { MathFieldRenderer } from "./renderer";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export interface MathFieldProps {
  /** Element whose pointer events make ripples and the hover light. */
  interactionRef: RefObject<HTMLElement | null>;
  /** Content column; the background stays calmer behind it. */
  columnRef: RefObject<HTMLElement | null>;
}

/**
 * Home screen background: digits and formulas surfacing on a slow swell,
 * with a ripple from every click. Renders nothing visible (the CSS
 * background stays) when WebGL2 is unavailable.
 */
export default function MathField({ interactionRef, columnRef }: MathFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let disconnect = () => {};
    loadAtlas()
      .then((atlas) => {
        if (disposed) return;
        const motion = window.matchMedia(REDUCED_MOTION);
        const renderer = MathFieldRenderer.create(canvas, atlas, {
          dark: document.documentElement.classList.contains("dark"),
          reducedMotion: motion.matches,
          onFirstFrame: () => setShown(true),
        });
        if (renderer) disconnect = connect(renderer, canvas, interactionRef.current, columnRef.current, motion);
      })
      .catch((e: unknown) => console.warn("Home background disabled:", e));
    return () => {
      disposed = true;
      disconnect();
    };
  }, [interactionRef, columnRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-700 ease-out ${shown ? "opacity-100" : "opacity-0"}`}
      data-testid="home-background"
    />
  );
}

/** Wire the renderer to the page; returns the teardown. */
function connect(
  renderer: MathFieldRenderer,
  canvas: HTMLCanvasElement,
  interaction: HTMLElement | null,
  column: HTMLElement | null,
  motion: MediaQueryList,
): () => void {
  const root = document.documentElement;
  // The canvas does not scroll with the content, so its box only changes on resize.
  let box = canvas.getBoundingClientRect();
  const measure = () => {
    box = canvas.getBoundingClientRect();
    renderer.setSize(box.width, box.height);
    if (column) {
      const c = column.getBoundingClientRect();
      renderer.setColumn(c.left - box.left, c.right - box.left);
    }
  };
  const resize = new ResizeObserver(measure);
  resize.observe(canvas);
  if (column) resize.observe(column);
  // A scroll bar appearing narrows the content without resizing the canvas.
  if (interaction) resize.observe(interaction);
  measure();

  const theme = new MutationObserver(() => renderer.setTheme(root.classList.contains("dark")));
  theme.observe(root, { attributes: true, attributeFilter: ["class"] });

  const onMotion = () => renderer.setReducedMotion(motion.matches);
  motion.addEventListener("change", onMotion);
  const onVisibility = () => renderer.setVisible(!document.hidden);
  document.addEventListener("visibilitychange", onVisibility);

  const onDown = (e: PointerEvent) => {
    if (e.button === 0) renderer.ripple(e.clientX - box.left, e.clientY - box.top);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") renderer.pointerMove(e.clientX - box.left, e.clientY - box.top);
  };
  const onLeave = () => renderer.pointerLeave();
  interaction?.addEventListener("pointerdown", onDown);
  interaction?.addEventListener("pointermove", onMove);
  interaction?.addEventListener("pointerleave", onLeave);

  return () => {
    interaction?.removeEventListener("pointerdown", onDown);
    interaction?.removeEventListener("pointermove", onMove);
    interaction?.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    motion.removeEventListener("change", onMotion);
    theme.disconnect();
    resize.disconnect();
    renderer.dispose();
  };
}
