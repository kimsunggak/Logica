import TinySDF from "@mapbox/tiny-sdf";
import { DIGIT_GLYPHS, formulaCharset } from "./formulas";
import type { GlyphInfo, GlyphSource } from "./layout";

/**
 * Signed distance field atlas of every glyph the background draws. A distance
 * field stays sharp at any scale and gives the glow for free: the shader reads
 * how far a pixel is from the outline instead of a plain coverage value.
 */

/** Glyphs are rasterized at this size and scaled by the shader. */
const GEN_SIZE = 40;
/** Padding around each glyph; large enough that the field reaches 0 at the quad edge. */
const BUFFER = 8;
const RADIUS = 10;
const CUTOFF = 0.25;
const MIN_WIDTH = 1024;
const GAP = 2;
const SPACE_ADVANCE = 0.3;

const MONO = `"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;
const SERIF = `"STIX Two Text", Cambria, "Times New Roman", "Noto Serif", "DejaVu Serif", serif`;

/** The digit glyphs share one row of equal cells so the shader can pick any of them by index. */
export interface DigitStrip {
  u0: number;
  v0: number;
  /** Size of one cell in uv. */
  du: number;
  dv: number;
  count: number;
  /** Size of one cell in em. */
  qw: number;
  qh: number;
}

export interface Atlas extends GlyphSource {
  width: number;
  height: number;
  /** One byte per texel: the distance field (outline at 1 - cutoff = 0.75). */
  data: Uint8Array;
  digits: DigitStrip;
}

type Bitmap = ReturnType<TinySDF["draw"]>;

let cached: Promise<Atlas> | null = null;

/** Built once per session (about 100 glyphs) and reused every time the home screen opens. */
export function loadAtlas(): Promise<Atlas> {
  if (!cached) {
    cached = (async () => {
      await document.fonts?.ready;
      return buildAtlas();
    })();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

function sdf(fontFamily: string, fontStyle: string, fontWeight: string): TinySDF {
  return new TinySDF({ fontSize: GEN_SIZE, buffer: BUFFER, radius: RADIUS, cutoff: CUTOFF, fontFamily, fontStyle, fontWeight });
}

function buildAtlas(): Atlas {
  const mono = sdf(MONO, "normal", "500");
  const digitBitmaps = DIGIT_GLYPHS.map((c) => mono.draw(c));
  const maxTop = Math.max(...digitBitmaps.map((b) => b.glyphTop));
  const maxDescent = Math.max(...digitBitmaps.map((b) => b.glyphHeight - b.glyphTop));
  const cellW = Math.max(...digitBitmaps.map((b) => b.width));
  const cellH = maxTop + maxDescent + 2 * BUFFER;
  const width = Math.max(MIN_WIDTH, cellW * digitBitmaps.length);

  const serif = sdf(SERIF, "italic", "normal");
  const formulaBitmaps = formulaCharset()
    .map((char) => ({ char, bitmap: serif.draw(char) }))
    .filter(({ bitmap }) => bitmap.glyphWidth > 0 && bitmap.glyphHeight > 0)
    .sort((a, b) => b.bitmap.height - a.bitmap.height);

  // Shelf packing below the digit row.
  const places: { x: number; y: number }[] = [];
  let x = 0;
  let y = cellH + GAP;
  let shelf = 0;
  for (const { bitmap } of formulaBitmaps) {
    if (x + bitmap.width > width) {
      x = 0;
      y += shelf + GAP;
      shelf = 0;
    }
    places.push({ x, y });
    x += bitmap.width + GAP;
    shelf = Math.max(shelf, bitmap.height);
  }
  const height = y + shelf;
  const data = new Uint8Array(width * height);

  digitBitmaps.forEach((b, i) => {
    const ox = i * cellW + Math.floor((cellW - b.width) / 2);
    blit(data, width, b, ox, maxTop - b.glyphTop);
  });

  const glyphs = new Map<string, GlyphInfo>();
  formulaBitmaps.forEach(({ char, bitmap: b }, i) => {
    const { x: px, y: py } = places[i];
    blit(data, width, b, px, py);
    glyphs.set(char, {
      u0: px / width,
      v0: py / height,
      u1: (px + b.width) / width,
      v1: (py + b.height) / height,
      advance: b.glyphAdvance / GEN_SIZE,
      qx: (b.glyphLeft - BUFFER) / GEN_SIZE,
      qy: -(b.glyphTop + BUFFER) / GEN_SIZE,
      qw: b.width / GEN_SIZE,
      qh: b.height / GEN_SIZE,
    });
  });

  return {
    width,
    height,
    data,
    digits: {
      u0: 0,
      v0: 0,
      du: cellW / width,
      dv: cellH / height,
      count: digitBitmaps.length,
      qw: cellW / GEN_SIZE,
      qh: cellH / GEN_SIZE,
    },
    glyph: (char) => glyphs.get(char),
    spaceAdvance: SPACE_ADVANCE,
  };
}

function blit(dst: Uint8Array, dstWidth: number, b: Bitmap, x: number, y: number): void {
  for (let row = 0; row < b.height; row++) {
    dst.set(b.data.subarray(row * b.width, (row + 1) * b.width), (y + row) * dstWidth + x);
  }
}
