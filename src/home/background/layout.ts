import { FORMULAS, parseFormula } from "./formulas";

/**
 * Where every glyph of the home background sits. Pure data: the renderer
 * uploads these arrays once and the shader animates them.
 *
 * Each instance is STRIDE floats:
 *   x, y, w, h        quad in CSS px (SDF padding included)
 *   u0, v0, u1, v1    atlas rect (unused for digits: the shader picks the cell)
 *   seed, layer, group, extra
 * `group` is -1 for digits; `extra` is the fade rate (cycles/s) for digits and
 * the character's position in its formula (0..1) for formula glyphs.
 */
export const STRIDE = 12;

/** One glyph of the atlas, sizes in em of the font size it is drawn at. */
export interface GlyphInfo {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pen advance. */
  advance: number;
  /** Quad offset from the pen position (x) and from the baseline (y, negative is up). */
  qx: number;
  qy: number;
  /** Quad size. */
  qw: number;
  qh: number;
}

export interface GlyphSource {
  glyph(char: string): GlyphInfo | undefined;
  spaceAdvance: number;
}

/** Stable hash of three integers to [0, 1): a resize keeps every digit where it was. */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul((c | 0) + 0x3c6ef372, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Small seeded PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Digit field

/** Far to near: smaller, sparser and dimmer at the back. */
export const DIGIT_LAYERS = [
  { cell: 30, size: 11, density: 0.5 },
  { cell: 44, size: 14, density: 0.45 },
  { cell: 64, size: 17, density: 0.4 },
] as const;
export const MAX_DIGITS = 9000;

/**
 * Digits on a jittered grid per layer, ordered by a stable priority so that a
 * lower quality level can simply draw the first N.
 */
export function buildDigitField(width: number, height: number, cell: { qw: number; qh: number }): Float32Array<ArrayBuffer> {
  const values: number[] = [];
  const priority: number[] = [];
  DIGIT_LAYERS.forEach((layer, l) => {
    const cols = Math.ceil(width / layer.cell) + 1;
    const rows = Math.ceil(height / layer.cell) + 1;
    const w = cell.qw * layer.size;
    const h = cell.qh * layer.size;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (hash3(l, c, r) >= layer.density) continue;
        const cx = (c + 0.15 + 0.7 * hash3(l + 11, c, r)) * layer.cell;
        const cy = (r + 0.15 + 0.7 * hash3(l + 23, c, r)) * layer.cell;
        if (cx > width + w || cy > height + h) continue;
        const seed = hash3(l + 37, c, r);
        const rate = 1 / (10 + 14 * hash3(l + 51, c, r));
        priority.push(hash3(l + 71, c, r));
        values.push(cx - w / 2, cy - h / 2, w, h, 0, 0, 0, 0, seed, l, -1, rate);
      }
    }
  });
  const order = priority.map((_, i) => i).sort((a, b) => priority[b] - priority[a]);
  const count = Math.min(order.length, MAX_DIGITS);
  const out = new Float32Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const from = order[i] * STRIDE;
    for (let k = 0; k < STRIDE; k++) out[i * STRIDE + k] = values[from + k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formulas

export const MAX_GROUPS = 32;
export const SLOTS_PER_GROUP = 32;
export const FORMULA_INSTANCES = MAX_GROUPS * SLOTS_PER_GROUP;

const SCRIPT_SCALE = 0.68;
const SUPERSCRIPT_RISE = -0.4;
const SUBSCRIPT_DROP = 0.18;
/** Free space kept around each formula so two never touch. */
const FORMULA_GAP = 28;
const EDGE_MARGIN = 12;
const PLACEMENT_TRIES = 24;
const LAYER_SIZE = [12.5, 14.5, 17] as const;

interface LaidOutChar {
  x: number;
  y: number;
  w: number;
  h: number;
  info: GlyphInfo;
  order: number;
}

export interface LaidOutFormula {
  chars: LaidOutChar[];
  width: number;
  height: number;
}

/** Place a formula's glyphs in em, with the bounding box starting at (0, 0). */
export function layoutFormula(source: string, glyphs: GlyphSource): LaidOutFormula {
  const chars: LaidOutChar[] = [];
  let pen = 0;
  for (const token of parseFormula(source)) {
    const scale = token.script === 0 ? 1 : SCRIPT_SCALE;
    if (token.char === " ") {
      pen += glyphs.spaceAdvance * scale;
      continue;
    }
    const info = glyphs.glyph(token.char);
    if (!info) {
      pen += 0.5 * scale;
      continue;
    }
    const shift = token.script === 1 ? SUPERSCRIPT_RISE : token.script === -1 ? SUBSCRIPT_DROP : 0;
    chars.push({ x: pen + info.qx * scale, y: shift + info.qy * scale, w: info.qw * scale, h: info.qh * scale, info, order: 0 });
    pen += info.advance * scale;
  }
  if (chars.length === 0) return { chars, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of chars) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  chars.forEach((c, i) => {
    c.x -= minX;
    c.y -= minY;
    c.order = chars.length > 1 ? i / (chars.length - 1) : 0;
  });
  return { chars, width: maxX - minX, height: maxY - minY };
}

/** Fade in, hold, fade out, then a dark pause in which the group may be replaced. */
export function lifeEnvelope(f: number): number {
  return smoothstep(0, 0.2, f) * (1 - smoothstep(0.6, 0.86, f));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** How many formulas a screen of this size holds. */
export function targetGroupCount(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  return Math.max(4, Math.min(MAX_GROUPS, Math.round((width * height) / 95000)));
}

interface Group {
  formula: number;
  period: number;
  phase: number;
  cycle: number;
  /** No free spot was found this cycle: stay dark until the next one. */
  hidden: boolean;
}

/**
 * Formulas with their own life cycle. The CPU owns the cycle so a formula is
 * only ever swapped for another one (and moved) while it is fully dark.
 */
export class FormulaField {
  /** Instance data for all MAX_GROUPS * SLOTS_PER_GROUP slots (unused slots have zero size). */
  readonly instances = new Float32Array(FORMULA_INSTANCES * STRIDE);
  /** Current brightness of each group, 0..1. */
  readonly life = new Float32Array(MAX_GROUPS);
  /** Bounding box of each group: x0, y0, x1, y1 (zero when unused). */
  readonly rects = new Float32Array(MAX_GROUPS * 4);
  /** Range of groups whose instance slots changed since the last `takeDirty`. */
  private dirtyFrom = Infinity;
  private dirtyTo = -1;
  rectsChanged = true;

  private readonly layouts: LaidOutFormula[];
  private readonly groups: Group[] = [];
  private count = 0;
  private width = 0;
  private height = 0;
  private started = false;

  constructor(
    glyphs: GlyphSource,
    private readonly random: () => number,
  ) {
    this.layouts = FORMULAS.map((f) => layoutFormula(f, glyphs));
  }

  get groupCount(): number {
    return this.count;
  }

  resize(width: number, height: number, time: number): void {
    this.width = width;
    this.height = height;
    const target = targetGroupCount(width, height);
    for (let g = this.count; g < target; g++) {
      const period = 14 + this.random() * 12;
      // The first screenful starts mid-cycle; groups added later start dark.
      const phase = this.started ? (period - (time % period)) % period : this.random() * period;
      this.groups[g] = { formula: -1, period, phase, cycle: Math.floor((time + phase) / period), hidden: false };
      // Count it before placing so the groups added in this batch avoid each other.
      this.count = g + 1;
      this.spawn(g);
    }
    for (let g = target; g < this.count; g++) this.clear(g);
    this.count = target;
    this.started = true;
    this.update(time);
  }

  /** Advance the cycles to `time`; groups that start a new cycle get a new formula and spot. */
  update(time: number): void {
    for (let g = 0; g < this.count; g++) {
      const group = this.groups[g];
      const pos = (time + group.phase) / group.period;
      const cycle = Math.floor(pos);
      if (cycle !== group.cycle) {
        group.cycle = cycle;
        this.spawn(g);
      }
      this.life[g] = group.hidden ? 0 : lifeEnvelope(pos - cycle);
    }
  }

  /** The changed slot range in floats, or null; resets the record. */
  takeDirty(): { start: number; end: number } | null {
    if (this.dirtyTo < 0) return null;
    const range = { start: this.dirtyFrom * SLOTS_PER_GROUP * STRIDE, end: (this.dirtyTo + 1) * SLOTS_PER_GROUP * STRIDE };
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
    return range;
  }

  /** Mark everything for upload (after a lost WebGL context is restored). */
  markAllDirty(): void {
    this.dirtyFrom = 0;
    this.dirtyTo = MAX_GROUPS - 1;
    this.rectsChanged = true;
  }

  private spawn(g: number): void {
    const group = this.groups[g];
    const formula = this.pickFormula(g);
    const layout = this.layouts[formula];
    const layerRoll = this.random();
    const layer = layerRoll < 0.4 ? 0 : layerRoll < 0.75 ? 1 : 2;
    const size = LAYER_SIZE[layer] + this.random() * 2;
    const w = layout.width * size;
    const h = layout.height * size;
    const spot = layout.chars.length > 0 ? this.findSpot(g, w, h) : null;
    group.formula = formula;
    if (!spot) {
      group.hidden = true;
      this.clear(g);
      return;
    }
    group.hidden = false;
    const [x, y] = spot;
    const base = g * SLOTS_PER_GROUP;
    for (let i = 0; i < SLOTS_PER_GROUP; i++) {
      const o = (base + i) * STRIDE;
      const c = layout.chars[i];
      if (!c) {
        this.instances.fill(0, o, o + STRIDE);
        continue;
      }
      const { u0, v0, u1, v1 } = c.info;
      this.instances.set([x + c.x * size, y + c.y * size, c.w * size, c.h * size, u0, v0, u1, v1, this.random(), layer, g, c.order], o);
    }
    this.rects.set([x, y, x + w, y + h], g * 4);
    this.markDirty(g);
  }

  private clear(g: number): void {
    const base = g * SLOTS_PER_GROUP * STRIDE;
    this.instances.fill(0, base, base + SLOTS_PER_GROUP * STRIDE);
    this.rects.fill(0, g * 4, g * 4 + 4);
    this.life[g] = 0;
    this.markDirty(g);
  }

  private markDirty(g: number): void {
    this.dirtyFrom = Math.min(this.dirtyFrom, g);
    this.dirtyTo = Math.max(this.dirtyTo, g);
    this.rectsChanged = true;
  }

  /** A formula no other visible group shows, when there is one. */
  private pickFormula(g: number): number {
    const inUse = new Set<number>();
    for (let i = 0; i < this.count; i++) if (i !== g && !this.groups[i]?.hidden) inUse.add(this.groups[i]?.formula ?? -1);
    let pick = Math.floor(this.random() * this.layouts.length);
    for (let tries = 0; tries < this.layouts.length && inUse.has(pick); tries++) pick = (pick + 1) % this.layouts.length;
    return pick;
  }

  private findSpot(g: number, w: number, h: number): [number, number] | null {
    const freeW = this.width - w - 2 * EDGE_MARGIN;
    const freeH = this.height - h - 2 * EDGE_MARGIN;
    if (freeW < 0 || freeH < 0) return null;
    for (let tries = 0; tries < PLACEMENT_TRIES; tries++) {
      const x = EDGE_MARGIN + this.random() * freeW;
      const y = EDGE_MARGIN + this.random() * freeH;
      if (!this.overlapsOthers(g, x, y, x + w, y + h)) return [x, y];
    }
    return null;
  }

  private overlapsOthers(g: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const r = this.rects;
    for (let i = 0; i < this.count; i++) {
      if (i === g || this.groups[i]?.hidden) continue;
      const o = i * 4;
      if (r[o + 2] <= r[o]) continue; // unused
      if (x0 < r[o + 2] + FORMULA_GAP && x1 + FORMULA_GAP > r[o] && y0 < r[o + 3] + FORMULA_GAP && y1 + FORMULA_GAP > r[o + 1]) return true;
    }
    return false;
  }
}
