/**
 * Proportional split of the workspace: the editor, preview and chat panes
 * share the free width by weight (CSS flex-grow), so together they always fit
 * the window and can never overlap. Dragging the border between two panes
 * moves weight from one to the other and leaves the rest unchanged.
 */

/**
 * New weights for two neighbouring panes after their border moved by `delta`
 * pixels. `pxA`/`pxB` are their widths when the drag started; each pane keeps
 * at least its minimum width.
 */
export function resizePair(px: [number, number], weights: [number, number], delta: number, min: [number, number]): [number, number] {
  const total = px[0] + px[1];
  const sum = weights[0] + weights[1];
  if (total <= 0 || sum <= 0) return weights;
  const lo = Math.min(min[0], total / 2);
  const hi = Math.max(total - min[1], total / 2);
  const a = Math.max(lo, Math.min(hi, px[0] + delta));
  const wa = (sum * a) / total;
  return [wa, sum - wa];
}

/** Split the pair's share evenly (double-click on their border). */
export function equalPair(weights: [number, number]): [number, number] {
  const half = (weights[0] + weights[1]) / 2;
  return [half, half];
}
