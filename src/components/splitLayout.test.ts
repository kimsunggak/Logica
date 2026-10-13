import { describe, expect, it } from "vitest";
import { equalPair, resizePair } from "./splitLayout";

describe("resizePair", () => {
  it("moves weight between the two panes and keeps their total", () => {
    const [a, b] = resizePair([500, 500], [0.3, 0.3], 100, [200, 200]);
    expect(a + b).toBeCloseTo(0.6);
    expect(a / (a + b)).toBeCloseTo(0.6); // 600 of 1000 px
  });

  it("respects each pane's minimum width", () => {
    expect(resizePair([500, 500], [1, 1], 1000, [200, 300])[1] / 2).toBeCloseTo(0.3); // 300 of 1000
    expect(resizePair([500, 500], [1, 1], -1000, [200, 300])[0] / 2).toBeCloseTo(0.2); // 200 of 1000
  });

  it("never inverts when both minimums do not fit", () => {
    const [a, b] = resizePair([150, 150], [1, 1], 100, [200, 200]);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});

describe("equalPair", () => {
  it("splits the pair's share 50:50", () => {
    expect(equalPair([0.5, 0.1])).toEqual([0.3, 0.3]);
  });
});
