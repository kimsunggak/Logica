import { describe, expect, it } from "vitest";
import { FrameGovernor, QUALITY_LEVELS } from "./quality";
import { MAX_RIPPLES, RIPPLE_LIFETIME, RippleBuffer } from "./ripples";

describe("RippleBuffer", () => {
  it("replaces the oldest ripple when full", () => {
    const ripples = new RippleBuffer();
    for (let i = 0; i <= MAX_RIPPLES; i++) ripples.add(i, i, i);
    expect(ripples.data[0]).toBe(MAX_RIPPLES); // slot 0 now holds the newest
    expect(ripples.data[4]).toBe(1);
  });

  it("is active only while a ripple is visible", () => {
    const ripples = new RippleBuffer();
    expect(ripples.activeAt(0)).toBe(false);
    ripples.add(10, 10, 5);
    expect(ripples.activeAt(4.9)).toBe(false);
    expect(ripples.activeAt(5 + RIPPLE_LIFETIME / 2)).toBe(true);
    expect(ripples.activeAt(5 + RIPPLE_LIFETIME + 0.01)).toBe(false);
    ripples.clear();
    expect(ripples.activeAt(5.5)).toBe(false);
  });
});

describe("FrameGovernor", () => {
  const feed = (g: FrameGovernor, ms: number, frames: number) => {
    let changes = 0;
    for (let i = 0; i < frames; i++) if (g.sample(ms)) changes++;
    return changes;
  };

  it("keeps full quality at 60 fps", () => {
    const g = new FrameGovernor();
    expect(feed(g, 1000 / 60, 2000)).toBe(0);
    expect(g.level).toBe(QUALITY_LEVELS[0]);
  });

  it("steps down one level at a time when moderately slow, then stops animating", () => {
    const g = new FrameGovernor();
    feed(g, 30, 80); // 20 warm-up + 60 measured frames
    expect(g.levelIndex).toBe(1);
    feed(g, 30, 80);
    expect(g.levelIndex).toBe(2);
    expect(g.still).toBe(false);
    feed(g, 30, 80);
    expect(g.still).toBe(true);
    expect(feed(g, 30, 500)).toBe(0);
  });

  it("skips a level when far too slow", () => {
    const g = new FrameGovernor();
    feed(g, 60, 80);
    expect(g.levelIndex).toBe(2);
  });

  it("ignores stalls", () => {
    const g = new FrameGovernor();
    for (let i = 0; i < 400; i++) g.sample(i % 10 === 0 ? 900 : 16);
    expect(g.levelIndex).toBe(0);
  });
});
