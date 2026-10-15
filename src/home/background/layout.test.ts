import { describe, expect, it } from "vitest";
import { FORMULAS, formulaCharset, parseFormula } from "./formulas";
import {
  FormulaField,
  MAX_GROUPS,
  SLOTS_PER_GROUP,
  STRIDE,
  buildDigitField,
  layoutFormula,
  lifeEnvelope,
  seededRandom,
  targetGroupCount,
  type GlyphSource,
} from "./layout";

const glyphs: GlyphSource = {
  glyph: (char) => (char === "?" ? undefined : { u0: 0, v0: 0, u1: 0.1, v1: 0.1, advance: 0.6, qx: -0.1, qy: -0.9, qw: 0.8, qh: 1.2 }),
  spaceAdvance: 0.3,
};
const CELL = { qw: 1, qh: 1.35 };

describe("parseFormula", () => {
  it("raises and lowers single characters and groups", () => {
    expect(parseFormula("x^2")).toEqual([
      { char: "x", script: 0 },
      { char: "2", script: 1 },
    ]);
    expect(parseFormula("z_{n+1}").map((t) => `${t.char}${t.script}`)).toEqual(["z0", "n-1", "+-1", "1-1"]);
  });

  it("drops markers nested inside a group instead of drawing them", () => {
    const tokens = parseFormula("e^{−x^2}");
    expect(tokens.map((t) => t.char).join("")).toBe("e−x2");
    expect(tokens.slice(1).every((t) => t.script === 1)).toBe(true);
  });

  it("keeps every formula within the slots of one group", () => {
    for (const f of FORMULAS) {
      const drawn = parseFormula(f).filter((t) => t.char !== " ");
      expect(drawn.length, f).toBeLessThanOrEqual(SLOTS_PER_GROUP);
    }
  });

  it("asks the atlas only for drawable characters", () => {
    const chars = formulaCharset();
    expect(chars).not.toContain(" ");
    expect(chars).not.toContain("^");
    expect(chars).not.toContain("{");
    expect(new Set(chars).size).toBe(chars.length);
  });
});

describe("layoutFormula", () => {
  it("starts the bounding box at the origin and orders characters left to right", () => {
    const layout = layoutFormula("a^2 + b", glyphs);
    expect(Math.min(...layout.chars.map((c) => c.x))).toBeCloseTo(0);
    expect(Math.min(...layout.chars.map((c) => c.y))).toBeCloseTo(0);
    expect(layout.chars.map((c) => c.order)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(layout.chars[1].w).toBeLessThan(layout.chars[0].w); // the superscript is smaller
  });

  it("skips characters missing from the atlas", () => {
    expect(layoutFormula("a?b", glyphs).chars).toHaveLength(2);
  });
});

describe("buildDigitField", () => {
  it("keeps digits in place when the window grows", () => {
    const key = (d: Float32Array, i: number) => `${d[i * STRIDE].toFixed(2)},${d[i * STRIDE + 1].toFixed(2)}`;
    const small = buildDigitField(800, 600, CELL);
    const large = buildDigitField(1200, 600, CELL);
    const inLarge = new Set(Array.from({ length: large.length / STRIDE }, (_, i) => key(large, i)));
    for (let i = 0; i < small.length / STRIDE; i++) expect(inLarge.has(key(small, i))).toBe(true);
    expect(large.length).toBeGreaterThan(small.length);
  });

  it("marks every instance as a sized digit", () => {
    const field = buildDigitField(640, 480, CELL);
    expect(field.length).toBeGreaterThan(0);
    for (let i = 0; i < field.length / STRIDE; i++) {
      expect(field[i * STRIDE + 2]).toBeGreaterThan(0);
      expect(field[i * STRIDE + 10]).toBe(-1);
    }
  });
});

describe("lifeEnvelope", () => {
  it("fades in, holds and stays dark at the end of the cycle", () => {
    expect(lifeEnvelope(0)).toBe(0);
    expect(lifeEnvelope(0.4)).toBe(1);
    expect(lifeEnvelope(0.9)).toBe(0);
  });
});

describe("FormulaField", () => {
  function overlap(r: Float32Array, a: number, b: number): boolean {
    const [ax0, ay0, ax1, ay1] = r.subarray(a * 4, a * 4 + 4);
    const [bx0, by0, bx1, by1] = r.subarray(b * 4, b * 4 + 4);
    return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
  }

  it("places formulas inside the screen without overlaps", () => {
    const field = new FormulaField(glyphs, seededRandom(7));
    field.resize(1600, 900, 0);
    expect(field.groupCount).toBe(targetGroupCount(1600, 900));
    const r = field.rects;
    const used: number[] = [];
    for (let g = 0; g < field.groupCount; g++) {
      if (r[g * 4 + 2] <= r[g * 4]) continue;
      used.push(g);
      expect(r[g * 4]).toBeGreaterThanOrEqual(0);
      expect(r[g * 4 + 1]).toBeGreaterThanOrEqual(0);
      expect(r[g * 4 + 2]).toBeLessThanOrEqual(1600);
      expect(r[g * 4 + 3]).toBeLessThanOrEqual(900);
    }
    expect(used.length).toBeGreaterThan(field.groupCount / 2);
    for (const a of used) for (const b of used) if (a < b) expect(overlap(r, a, b)).toBe(false);
  });

  it("only swaps a formula while it is dark", () => {
    const field = new FormulaField(glyphs, seededRandom(3));
    field.resize(1400, 800, 0);
    const slot = SLOTS_PER_GROUP * STRIDE;
    let previous = field.instances.slice();
    let previousLife = field.life.slice();
    let swaps = 0;
    for (let frame = 1; frame < 60 * 70; frame++) {
      field.update(frame / 60);
      for (let g = 0; g < field.groupCount; g++) {
        const now = field.instances.subarray(g * slot, (g + 1) * slot);
        const before = previous.subarray(g * slot, (g + 1) * slot);
        if (now.some((v, i) => v !== before[i])) {
          swaps++;
          expect(previousLife[g]).toBe(0);
          expect(field.life[g]).toBeLessThan(0.001);
        }
      }
      previous = field.instances.slice();
      previousLife = field.life.slice();
    }
    expect(swaps).toBeGreaterThan(field.groupCount); // every group cycled at least once in 70 s
  });

  it("reports changed slots once", () => {
    const field = new FormulaField(glyphs, seededRandom(1));
    field.resize(1000, 700, 0);
    const range = field.takeDirty();
    expect(range).not.toBeNull();
    expect(range!.start).toBe(0);
    expect(field.takeDirty()).toBeNull();
  });

  it("fades formulas in after a jump in time instead of popping in", () => {
    const field = new FormulaField(glyphs, seededRandom(9));
    field.resize(1400, 800, 37);
    field.update(500); // e.g. reduced motion turned off, or the window was hidden for minutes
    for (let g = 0; g < field.groupCount; g++) expect(field.life[g]).toBeLessThan(0.001);
    field.update(504);
    expect(Math.max(...field.life)).toBeGreaterThan(0.3);
  });

  it("darkens formulas that no longer fit after the window shrinks", () => {
    const field = new FormulaField(glyphs, seededRandom(11));
    field.resize(1600, 1000, 5);
    field.resize(1600, 500, 5.1);
    for (let g = 0; g < field.groupCount; g++) {
      if (field.rects[g * 4 + 3] > 500) throw new Error(`group ${g} still extends past the bottom`);
      if (field.rects[g * 4 + 2] === 0) expect(field.life[g]).toBe(0);
    }
  });

  it("shows new formulas at once while time stands still", () => {
    const field = new FormulaField(glyphs, seededRandom(13));
    field.resize(600, 500, 37, true);
    const before = field.groupCount;
    field.resize(1800, 1000, 37, true);
    let lit = 0;
    for (let g = before; g < field.groupCount; g++) if (field.life[g] > 0.5) lit++;
    expect(lit).toBeGreaterThan(0);
  });

  it("clears dropped groups and starts added ones dark", () => {
    const field = new FormulaField(glyphs, seededRandom(5));
    field.resize(1800, 1000, 0);
    const before = field.groupCount;
    field.resize(500, 400, 10);
    expect(field.groupCount).toBeLessThan(before);
    for (let g = field.groupCount; g < MAX_GROUPS; g++) {
      expect(field.life[g]).toBe(0);
      expect(field.rects.subarray(g * 4, g * 4 + 4).every((v) => v === 0)).toBe(true);
    }
    const kept = field.groupCount;
    field.resize(1800, 1000, 20);
    for (let g = kept; g < field.groupCount; g++) expect(field.life[g]).toBeLessThan(0.001);
  });
});
