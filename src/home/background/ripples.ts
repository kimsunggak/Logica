/** Clicks kept at once; a new one replaces the oldest. Must match MAX_RIPPLES in the shader. */
export const MAX_RIPPLES = 8;
/** Seconds a ripple stays visible. Must match RIPPLE_LIFETIME in the shader. */
export const RIPPLE_LIFETIME = 3.2;

const NEVER = -1e4;

/** Ring buffer of ripples, laid out as the shader's vec4 array: x, y, start time, strength. */
export class RippleBuffer {
  readonly data = new Float32Array(MAX_RIPPLES * 4);
  private next = 0;

  constructor() {
    this.clear();
  }

  add(x: number, y: number, time: number, strength = 1): void {
    this.data.set([x, y, time, strength], this.next * 4);
    this.next = (this.next + 1) % MAX_RIPPLES;
  }

  /** Whether any ripple is still visible at `time`. */
  activeAt(time: number): boolean {
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const age = time - this.data[i * 4 + 2];
      if (age >= 0 && age < RIPPLE_LIFETIME) return true;
    }
    return false;
  }

  clear(): void {
    for (let i = 0; i < MAX_RIPPLES; i++) this.data.set([0, 0, NEVER, 0], i * 4);
    this.next = 0;
  }
}
