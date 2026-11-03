/**
 * What the home background shows: a field of digits (and a few math symbols)
 * plus short formulas that drift in and out.
 *
 * Formulas use a tiny TeX-like markup: `^x` / `^{...}` raise and shrink, `_x` /
 * `_{...}` lower and shrink (one level only). Everything else is drawn as written.
 */

/** Glyphs of the digit field, in atlas order. The shader picks digits most of the time. */
export const DIGIT_GLYPHS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "−", "=", "×", "π", "∑", "∂", "∞"];
/** How many of DIGIT_GLYPHS are plain digits (the rest are symbols). */
export const DIGIT_COUNT = 10;

export const FORMULAS = [
  "e^{iπ} + 1 = 0",
  "a^2 + b^2 = c^2",
  "∑_{n=1}^{∞} 1/n^2 = π^2/6",
  "∫_0^1 x^2 dx = 1/3",
  "∂u/∂t = α∇^2u",
  "E = mc^2",
  "F = ma",
  "det(A − λI) = 0",
  "lim_{x→0} sin x / x = 1",
  "f(x) = ∑ a_n x^n",
  "∇ × B = μ_0 J",
  "σ^2 = E[X^2] − μ^2",
  "P(A|B) = P(B|A)P(A)/P(B)",
  "x = (−b ± √(b^2 − 4ac))/2a",
  "iℏ ∂ψ/∂t = Hψ",
  "e^x = ∑ x^n/n!",
  "φ = (1 + √5)/2",
  "∮ E dl = −dΦ/dt",
  "z_{n+1} = z_n^2 + c",
  "Ax = λx",
  "∫ e^{−x^2} dx = √π",
  "ζ(s) = ∑ n^{−s}",
  "f′(x) ≈ (f(x+h) − f(x))/h",
  "sin^2θ + cos^2θ = 1",
  "H(X) = −∑ p log p",
  "Γ(n) = (n − 1)!",
  "∀ε > 0 ∃δ > 0",
  "∇ × E = −∂B/∂t",
  "log(ab) = log a + log b",
  "‖v‖ = √(v^T v)",
];

export interface FormulaToken {
  char: string;
  /** 1 = superscript, -1 = subscript, 0 = on the baseline. */
  script: -1 | 0 | 1;
}

/** Split a formula into drawable characters with their script level. */
export function parseFormula(source: string): FormulaToken[] {
  const chars = Array.from(source);
  const tokens: FormulaToken[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if ((c === "^" || c === "_") && i + 1 < chars.length) {
      const script = c === "^" ? 1 : -1;
      if (chars[i + 1] === "{") {
        let j = i + 2;
        // Scripts do not nest: a marker inside a group only drops out.
        for (; j < chars.length && chars[j] !== "}"; j++) if (chars[j] !== "^" && chars[j] !== "_") tokens.push({ char: chars[j], script });
        i = j;
      } else {
        tokens.push({ char: chars[i + 1], script });
        i += 1;
      }
      continue;
    }
    tokens.push({ char: c, script: 0 });
  }
  return tokens;
}

/** Every character the formulas need from the atlas (spaces excluded). */
export function formulaCharset(): string[] {
  const set = new Set<string>();
  for (const f of FORMULAS) for (const t of parseFormula(f)) if (t.char !== " ") set.add(t.char);
  return [...set];
}
