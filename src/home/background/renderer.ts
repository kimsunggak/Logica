import type { Atlas } from "./atlas";
import { FORMULA_INSTANCES, FormulaField, STRIDE, buildDigitField, digitFlowDomain, seededRandom } from "./layout";
import { FrameGovernor } from "./quality";
import { RippleBuffer } from "./ripples";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

type RGB = readonly [number, number, number];

export interface Theme {
  /** Must equal the home screen's CSS background (Home.tsx): the canvas is opaque and covers it. */
  background: RGB;
  ink: RGB;
  accent: RGB;
  /** 1 lets light add up (dark theme), 0 draws ordinary translucent ink. */
  additive: number;
  /** Peak opacity per depth layer, far to near. */
  layerAlpha: RGB;
}

const rgb = (hex: number): RGB => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

export const LIGHT_THEME: Theme = {
  background: rgb(0xf8fafc),
  ink: rgb(0x64748b),
  accent: rgb(0x0284c7),
  additive: 0,
  layerAlpha: [0.24, 0.36, 0.5],
};

export const DARK_THEME: Theme = {
  background: rgb(0x0c1117),
  ink: rgb(0x94a3b8),
  accent: rgb(0x38bdf8),
  additive: 1,
  layerAlpha: [0.3, 0.45, 0.62],
};

/** How much calmer the background is behind the content column. */
const COLUMN_DIM = 0.45;
const COLUMN_FEATHER = 90;
/** Reduced motion shows this moment of the animation, frozen. */
const STILL_TIME = 37;
/** Slow motion gains nothing from 120 Hz. */
const FRAME_MS = 1000 / 60;
/** Half rate while the window is unfocused or nobody has touched the screen for a while. */
const CALM_FRAME_MS = 1000 / 30;
const IDLE_AFTER_MS = 15000;
/**
 * A frame is skipped only when it comes sooner than this share of the target interval, so
 * displays up to 100 Hz draw every refresh. (With 0.75, an 85 to 90 Hz display drew every
 * other refresh, about 45 fps, and the governor took that for a slow machine.)
 */
const FRAME_SKIP = 0.6;
/** Frame times are not judged this soon after start: thumbnails and the atlas are still loading. */
const STARTUP_MS = 3000;
const POINTER_EASE = 5;

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const UNIFORMS = [
  "u_resolution",
  "u_time",
  "u_motion",
  "u_ripples",
  "u_groupLife",
  "u_groupRects",
  "u_pointer",
  "u_column",
  "u_digits",
  "u_digitCount",
  "u_layerAlpha",
  "u_atlas",
  "u_ink",
  "u_accent",
  "u_additive",
  "u_flowX",
  "u_flowY",
] as const;
type UniformName = (typeof UNIFORMS)[number];

export interface RendererOptions {
  dark: boolean;
  reducedMotion: boolean;
  /** Called after the first frame is on screen (again after a restored context), so the canvas can fade in. */
  onFirstFrame?: () => void;
  /** The WebGL context is gone; the canvas should step aside for the CSS background. */
  onContextLost?: () => void;
}

/**
 * Draws the home background with WebGL2: every glyph is one instance of a
 * quad, all of them in a single draw call, animated entirely in the vertex
 * shader. The CPU's per-frame work is a handful of uniforms.
 */
export class MathFieldRenderer {
  /** Null when WebGL2 or the shaders are unavailable; the plain CSS background stays. */
  static create(canvas: HTMLCanvasElement, atlas: Atlas, options: RendererOptions): MathFieldRenderer | null {
    const attributes: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      // A background effect should not wake a discrete GPU.
      powerPreference: "low-power",
    };
    // Where the browser admits to rendering in software, animating would slow the whole
    // window down: draw one still frame instead.
    let gl = canvas.getContext("webgl2", { ...attributes, failIfMajorPerformanceCaveat: true });
    const software = !gl;
    gl ??= canvas.getContext("webgl2", attributes);
    if (!gl) return null;
    try {
      return new MathFieldRenderer(canvas, gl, atlas, options, software);
    } catch (e) {
      console.warn("Home background disabled:", e);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return null;
    }
  }

  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private cornerBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
  /** Instances the GPU buffer has room for. */
  private capacity = 0;

  private readonly formulas: FormulaField;
  private digits = new Float32Array(0);
  private digitsDirty = true;
  private readonly ripples = new RippleBuffer();
  private readonly governor = new FrameGovernor();
  private theme: Theme;
  private reducedMotion: boolean;
  private readonly column = new Float32Array([0, 0, 0, COLUMN_FEATHER]);
  private readonly pointer = { x: 0, y: 0, strength: 0, target: 0 };

  private width = 0;
  private height = 0;
  private pendingSize: [number, number] | null = null;
  private readonly startTime = performance.now();
  private raf = 0;
  private lastDraw = 0;
  private lastFullRate = false;
  private lastActivity = performance.now();
  /** Uniforms that change only with the theme, the layout or the motion setting. */
  private settingsDirty = true;
  private visible = !document.hidden;
  private lost = false;
  private disposed = false;
  private drewFirst = false;
  /** The moment shown while not animating (reduced motion or a still frame). */
  private frozenTime: number | null = null;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly atlas: Atlas,
    private readonly options: RendererOptions,
    software: boolean,
  ) {
    this.governor.still = software;
    this.theme = options.dark ? DARK_THEME : LIGHT_THEME;
    this.reducedMotion = options.reducedMotion;
    // Not animating from the start: every redraw (resize, theme) must show the same moment.
    if (software || options.reducedMotion) this.frozenTime = STILL_TIME;
    this.formulas = new FormulaField(atlas, seededRandom((Math.random() * 2 ** 32) >>> 0));
    this.initGL();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  // -------------------------------------------------------------------------
  // Inputs

  setSize(width: number, height: number): void {
    this.pendingSize = [width, height];
    this.governor.resetWindow();
    this.requestRender();
  }

  /** The content column, in CSS px from the canvas's left edge. */
  setColumn(x0: number, x1: number): void {
    this.column[0] = x0;
    this.column[1] = x1;
    this.column[2] = x1 > x0 ? COLUMN_DIM : 0;
    this.settingsDirty = true;
    this.requestRender();
  }

  setTheme(dark: boolean): void {
    this.theme = dark ? DARK_THEME : LIGHT_THEME;
    this.settingsDirty = true;
    this.requestRender();
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.frozenTime = reduced ? STILL_TIME : this.governor.still ? (this.frozenTime ?? STILL_TIME) : null;
    this.ripples.clear();
    this.pointer.strength = this.pointer.target = 0;
    this.lastDraw = 0;
    this.settingsDirty = true;
    this.requestRender();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.cancelFrame();
      return;
    }
    // The pause is not a slow frame.
    this.lastDraw = 0;
    this.governor.resetWindow();
    this.requestRender();
  }

  /** Draw again when nothing else would, e.g. after the display scale changed. */
  refresh(): void {
    this.requestRender();
  }

  /** A click at CSS px (x, y) of the canvas. */
  ripple(x: number, y: number): void {
    if (!this.animating()) return;
    const now = performance.now();
    this.lastActivity = now;
    this.ripples.add(x, y, this.time(now));
    this.requestRender();
  }

  pointerMove(x: number, y: number): void {
    if (!this.animating()) return;
    this.lastActivity = performance.now();
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.target = 1;
  }

  pointerLeave(): void {
    this.pointer.target = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFrame();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const gl = this.gl;
    if (!this.lost) {
      gl.deleteBuffer(this.cornerBuffer);
      gl.deleteBuffer(this.instanceBuffer);
      gl.deleteTexture(this.texture);
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.program);
    }
    // Free the context now instead of waiting for GC; browsers cap live contexts. Not in
    // development: Fast Refresh reuses the canvas, and a lost context cannot be taken back.
    if (!import.meta.env.DEV) gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // -------------------------------------------------------------------------
  // Frame loop

  private animating(): boolean {
    return !this.reducedMotion && !this.governor.still;
  }

  private time(now: number): number {
    return this.frozenTime ?? (now - this.startTime) / 1000;
  }

  private requestRender(): void {
    if (this.raf || this.disposed || this.lost || !this.visible) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private cancelFrame(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (this.animating() && this.lastDraw) {
      const fullRate =
        document.hasFocus() && (now - this.lastActivity < IDLE_AFTER_MS || this.ripples.activeAt(this.time(now)));
      const interval = now - this.lastDraw;
      // Draw at about 60 or 30 fps whatever the display rate.
      if (interval < (fullRate ? FRAME_MS : CALM_FRAME_MS) * FRAME_SKIP) {
        this.requestRender();
        return;
      }
      // Half-rate frames are slow on purpose, so only full-rate intervals say anything.
      const measurable = fullRate && this.lastFullRate && now - this.startTime > STARTUP_MS;
      this.lastFullRate = fullRate;
      if (measurable && this.governor.sample(interval) && this.governor.still) {
        // Keep showing this moment, without a ripple or the hover light frozen half way.
        this.frozenTime = this.time(now);
        this.ripples.clear();
        this.pointer.strength = this.pointer.target = 0;
      }
    }
    this.draw(now);
    this.lastDraw = now;
    if (this.animating()) this.requestRender();
  };

  private draw(now: number): void {
    const gl = this.gl;
    const time = this.time(now);
    this.applySize(time);
    if (this.width <= 0 || this.height <= 0) return;
    this.formulas.update(time);
    this.uploadInstances();

    const p = this.pointer;
    const dt = this.lastDraw ? Math.min(0.1, (now - this.lastDraw) / 1000) : 0;
    p.strength += (p.target - p.strength) * (1 - Math.exp(-dt * POINTER_EASE));

    const theme = this.theme;
    const u = this.uniforms;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(theme.background[0], theme.background[1], theme.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(u.u_resolution, this.width, this.height);
    gl.uniform1f(u.u_time, time);
    gl.uniform4fv(u.u_ripples, this.ripples.data);
    gl.uniform1fv(u.u_groupLife, this.formulas.life);
    if (this.formulas.rectsChanged) {
      gl.uniform4fv(u.u_groupRects, this.formulas.rects);
      this.formulas.rectsChanged = false;
    }
    gl.uniform3f(u.u_pointer, p.x, p.y, p.strength);
    if (this.settingsDirty) {
      gl.uniform1f(u.u_motion, this.reducedMotion ? 0 : 1);
      gl.uniform4fv(u.u_column, this.column);
      gl.uniform3fv(u.u_layerAlpha, theme.layerAlpha);
      gl.uniform3fv(u.u_ink, theme.ink);
      gl.uniform3fv(u.u_accent, theme.accent);
      gl.uniform1f(u.u_additive, theme.additive);
      const domain = digitFlowDomain(this.width, this.height);
      gl.uniform3fv(u.u_flowX, domain.x);
      gl.uniform3fv(u.u_flowY, domain.y);
      this.settingsDirty = false;
    }

    const digitCount = this.digits.length / STRIDE;
    const drawn = FORMULA_INSTANCES + Math.floor(digitCount * this.governor.level.digitFraction);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, drawn);

    if (!this.drewFirst) {
      this.drewFirst = true;
      this.options.onFirstFrame?.();
    }
  }

  private applySize(time: number): void {
    if (this.pendingSize) {
      const [w, h] = this.pendingSize;
      this.pendingSize = null;
      if (w !== this.width || h !== this.height) {
        this.width = w;
        this.height = h;
        this.digits = buildDigitField(w, h, this.atlas.digits);
        this.digitsDirty = true;
        this.settingsDirty = true;
        this.formulas.resize(w, h, time, this.frozenTime !== null);
      }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, this.governor.level.maxDpr);
    const bw = Math.max(1, Math.round(this.width * dpr));
    const bh = Math.max(1, Math.round(this.height * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  /** Formulas first (fixed slots), then the digits; only changed ranges are sent. */
  private uploadInstances(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const needed = FORMULA_INSTANCES + this.digits.length / STRIDE;
    if (needed > this.capacity) {
      // Headroom so growing the window a little does not reallocate every frame.
      this.capacity = Math.ceil(needed * 1.25);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * STRIDE * 4, gl.DYNAMIC_DRAW);
      this.formulas.markAllDirty();
      this.digitsDirty = true;
    }
    const dirty = this.formulas.takeDirty();
    if (dirty) gl.bufferSubData(gl.ARRAY_BUFFER, dirty.start * 4, this.formulas.instances, dirty.start, dirty.end - dirty.start);
    if (this.digitsDirty) {
      if (this.digits.length > 0) gl.bufferSubData(gl.ARRAY_BUFFER, FORMULA_INSTANCES * STRIDE * 4, this.digits);
      this.digitsDirty = false;
    }
  }

  // -------------------------------------------------------------------------
  // GPU resources

  private initGL(): void {
    const gl = this.gl;
    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.program = program;
    for (const name of UNIFORMS) this.uniforms[name] = gl.getUniformLocation(program, name);

    const texture = gl.createTexture();
    this.texture = texture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.atlas.width, this.atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, this.atlas.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STRIDE * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    this.capacity = 0;

    const { digits } = this.atlas;
    gl.useProgram(program);
    gl.uniform1i(this.uniforms.u_atlas, 0);
    gl.uniform4f(this.uniforms.u_digits, digits.u0, digits.v0, digits.du, digits.dv);
    gl.uniform1f(this.uniforms.u_digitCount, digits.count);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Everything on the CPU side goes up again (also after a lost context).
    this.formulas.markAllDirty();
    this.digitsDirty = true;
    this.settingsDirty = true;
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    this.cancelFrame();
    this.options.onContextLost?.();
  };

  private readonly onContextRestored = (): void => {
    try {
      this.initGL();
    } catch (e) {
      console.warn("Home background could not restore WebGL:", e);
      return;
    }
    this.lost = false;
    this.lastDraw = 0;
    this.drewFirst = false;
    this.requestRender();
  };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders are no longer needed once linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}
