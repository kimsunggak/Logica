/** Quality steps, best first. The last fallback (a still frame) is `FrameGovernor.still`. */
export const QUALITY_LEVELS = [
  { digitFraction: 1, maxDpr: 2 },
  { digitFraction: 0.6, maxDpr: 1.5 },
  { digitFraction: 0.35, maxDpr: 1 },
] as const;

export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/** Frames ignored after start or a change, while caches and the compositor settle. */
const WARMUP_FRAMES = 20;
/** Frames averaged per decision. */
const WINDOW_FRAMES = 60;
/** Slower than about 45 fps on average means the machine is struggling. */
const SLOW_FRAME_MS = 1000 / 45;
/** A single gap this long is a stall (GC, window drag, sleep), not a frame rate. */
const STALL_MS = 250;

/**
 * Lowers the quality when frames come too slowly. The WebGL renderer string
 * cannot tell a software rasterizer from a GPU (WebKitGTK hides it), so this
 * judges by measured frame intervals instead. It only ever steps down: a busy
 * moment should not make the background flicker between levels.
 */
export class FrameGovernor {
  levelIndex = 0;
  /** Even the lowest level was too slow: draw one still frame and stop animating. */
  still = false;
  private warmup = WARMUP_FRAMES;
  private sum = 0;
  private frames = 0;

  get level(): QualityLevel {
    return QUALITY_LEVELS[this.levelIndex];
  }

  /** Feed the interval between two drawn frames; returns true when the quality changed. */
  sample(intervalMs: number): boolean {
    if (this.still || intervalMs <= 0 || intervalMs > STALL_MS) return false;
    if (this.warmup > 0) {
      this.warmup--;
      return false;
    }
    this.sum += intervalMs;
    this.frames++;
    if (this.frames < WINDOW_FRAMES) return false;
    const mean = this.sum / this.frames;
    this.sum = 0;
    this.frames = 0;
    if (mean <= SLOW_FRAME_MS) return false;
    // Far too slow (under about 22 fps) skips a level.
    const steps = mean > 2 * SLOW_FRAME_MS ? 2 : 1;
    const next = this.levelIndex + steps;
    if (next < QUALITY_LEVELS.length) this.levelIndex = next;
    else this.still = true;
    this.warmup = WARMUP_FRAMES;
    return true;
  }

  /** Forget the current window (after a pause, focus change or resize). */
  resetWindow(): void {
    this.sum = 0;
    this.frames = 0;
    this.warmup = Math.max(this.warmup, 10);
  }
}
