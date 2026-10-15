import { DIGIT_COUNT } from "./formulas";
import { MAX_GROUPS } from "./layout";
import { MAX_RIPPLES, RIPPLE_LIFETIME } from "./ripples";

/**
 * Everything that moves is computed here, per glyph instance: the wave that
 * makes glyphs surface and sink, each digit's own fade cycle, the click
 * ripples, the hover light and the scramble of digits a ripple passes over.
 * The CPU only sends the time, the ripples and each formula's brightness.
 */

const f = (n: number) => n.toFixed(1);

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

#define MAX_RIPPLES ${MAX_RIPPLES}
#define MAX_GROUPS ${MAX_GROUPS}

const float RIPPLE_SPEED = 440.0;    // px per second
const float RIPPLE_WIDTH = 48.0;     // px, width of the bright front
const float RIPPLE_TRAIL = 120.0;    // px, afterglow behind the front
const float RIPPLE_DECAY = 1.4;      // s
const float RIPPLE_LIFETIME = ${f(RIPPLE_LIFETIME)};
const float HOVER_RADIUS = 170.0;    // px

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;    // x, y, w, h in CSS px
layout(location = 2) in vec4 a_uv;      // u0, v0, u1, v1
layout(location = 3) in vec4 a_params;  // seed, layer, group (-1 = digit), rate or order

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_motion;                 // 0 = reduced motion: no scramble, no bob
uniform vec4 u_ripples[MAX_RIPPLES];    // x, y, start time, strength
uniform float u_groupLife[MAX_GROUPS];
uniform vec4 u_groupRects[MAX_GROUPS];  // x0, y0, x1, y1
uniform vec3 u_pointer;                 // x, y, strength
uniform vec4 u_column;                  // x0, x1, dim, feather
uniform vec4 u_digits;                  // u0, v0, cell du, cell dv
uniform float u_digitCount;
uniform vec3 u_layerAlpha;

out vec2 v_uv;
out float v_alpha;
out float v_glow;

// 2D simplex noise. Ashima Arts / Ian McEwan, MIT license.
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Hash without sine. Dave Hoskins, MIT license.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Swell: a few travelling waves whose fronts are bent by slow noise, so the
// crests curve and drift like water instead of sliding as straight stripes.
float swell(vec2 p, float t) {
  vec2 q = p * 0.0042;
  vec2 warp = vec2(snoise(q * 0.45 + vec2(t * 0.045, 0.0)), snoise(q * 0.45 + vec2(5.2, -t * 0.038)));
  q += warp * 0.85;
  float w = sin(dot(q, vec2(0.82, 0.57)) * 2.6 - t * 0.55)
          + 0.65 * sin(dot(q, vec2(-0.35, 0.94)) * 3.7 - t * 0.83)
          + 0.35 * sin(dot(q, vec2(0.99, -0.12)) * 5.3 - t * 1.21);
  // Narrow bright crests over wide dark troughs.
  return smoothstep(0.1, 1.45, w);
}

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  v_uv = vec2(0.0);
  v_alpha = 0.0;
  v_glow = 0.0;
}

void main() {
  vec2 size = a_rect.zw;
  if (size.x <= 0.0) { hide(); return; }

  float t = u_time;
  float seed = a_params.x;
  float layer = a_params.y;
  bool isDigit = a_params.z < -0.5;
  vec2 center = a_rect.xy + 0.5 * size;

  // Own life: digits fade in and out on their own cycle, formulas follow the CPU's cycle
  // and reveal left to right.
  float life;
  float cycle = 0.0;
  if (isDigit) {
    float pos = t * a_params.w + seed * 7.0;
    cycle = floor(pos);
    float f = pos - cycle;
    life = smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.8, 0.97, f));
  } else {
    float groupLife = u_groupLife[int(a_params.z + 0.5)];
    life = clamp(groupLife * 1.6 - a_params.w * 0.6, 0.0, 1.0);
  }
  float layerAlpha = mix(mix(u_layerAlpha.x, u_layerAlpha.y, step(0.5, layer)), u_layerAlpha.z, step(1.5, layer));

  // Ripples: a bright front with an afterglow behind it, fading with age.
  float act = 0.0;
  vec2 push = vec2(0.0);
  for (int i = 0; i < MAX_RIPPLES; i++) {
    vec4 r = u_ripples[i];
    float age = t - r.z;
    if (age < 0.0 || age > RIPPLE_LIFETIME) continue;
    vec2 away = center - r.xy;
    float dist = length(away);
    float d = dist - age * RIPPLE_SPEED;
    float env = r.w * exp(-age / RIPPLE_DECAY) * (1.0 - smoothstep(RIPPLE_LIFETIME * 0.55, RIPPLE_LIFETIME, age));
    float front = exp(-(d * d) / (RIPPLE_WIDTH * RIPPLE_WIDTH)) * env;
    float wake = d < 0.0 ? 0.3 * exp(d / RIPPLE_TRAIL) * env : 0.0;
    act += front + wake;
    if (dist > 0.001) push += away / dist * front;
  }
  act = min(act, 1.3);
  float hoverDist = distance(center, u_pointer.xy);
  float hover = u_pointer.z * 0.3 * exp(-(hoverDist * hoverDist) / (HOVER_RADIUS * HOVER_RADIUS));

  // Most glyphs are dark at any moment. Drop them as soon as that is certain, cheapest
  // test first, so the noise and the formula loop below only run for visible ones.
  // (Every factor applied later is at most 1, except the formula boost of 1.3.)
  if (1.3 * layerAlpha * life + act + hover < 0.004) { hide(); return; }

  float wave = swell(center, t);
  float base = layerAlpha * life * (isDigit ? wave : 1.3 * (0.5 + 0.5 * wave));
  // Calmer behind the content column.
  float inColumn = smoothstep(u_column.x - u_column.w, u_column.x, center.x)
                 * (1.0 - smoothstep(u_column.y, u_column.y + u_column.w, center.x));
  float alpha = base * (1.0 - u_column.z * inColumn);
  float glow = (act + hover) * (1.0 - 0.5 * u_column.z * inColumn);
  if (alpha + glow < 0.004) { hide(); return; }

  // Digits give way to a formula drawn over them.
  if (isDigit && alpha > 0.0) {
    for (int i = 0; i < MAX_GROUPS; i++) {
      float l = u_groupLife[i];
      if (l <= 0.0) continue;
      vec4 r = u_groupRects[i];
      if (center.x > r.x && center.x < r.z && center.y > r.y && center.y < r.w) alpha *= 1.0 - 0.92 * l;
    }
    if (alpha + glow < 0.004) { hide(); return; }
  }

  float scale = 1.0 + 0.16 * min(act, 1.0);
  vec2 bob = u_motion * vec2(sin(t * 0.7 + seed * 6.283), cos(t * 0.53 + seed * 4.1)) * (0.6 + 0.4 * layer);
  vec2 pos = center + bob + push * 7.0 + (a_corner - 0.5) * size * scale;
  vec2 clip = pos / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  if (isDigit) {
    // Swap digits only while dark; scramble them while a ripple passes over.
    float h = hash12(vec2(seed * 977.0, cycle));
    if (u_motion > 0.5 && act > 0.32) h = hash12(vec2(seed * 977.0, floor(t * 16.0) + 4099.0));
    float plain = ${f(DIGIT_COUNT)};
    float idx = h < 0.86 ? floor(h / 0.86 * plain) : plain + floor((h - 0.86) / 0.14 * (u_digitCount - plain));
    idx = min(idx, u_digitCount - 1.0);
    v_uv = u_digits.xy + vec2(idx * u_digits.z, 0.0) + a_corner * u_digits.zw;
  } else {
    v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  }
  v_alpha = alpha;
  v_glow = glow;
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

const float EDGE = 0.75;  // tiny-sdf puts the outline at 1 - cutoff

in vec2 v_uv;
in float v_alpha;
in float v_glow;

uniform sampler2D u_atlas;
uniform vec3 u_ink;
uniform vec3 u_accent;
uniform float u_additive;  // dark theme: light adds up instead of covering

out vec4 outColor;

void main() {
  float d = texture(u_atlas, v_uv).r;
  float aa = max(fwidth(d) * 0.7, 0.004);
  float core = smoothstep(EDGE - aa, EDGE + aa, d);
  float halo = smoothstep(0.2, EDGE, d);
  halo *= halo;
  float g = clamp(v_glow, 0.0, 1.3);
  float coreAlpha = core * clamp(v_alpha + 0.85 * g, 0.0, 1.0);
  float a = coreAlpha + 0.32 * g * halo * (1.0 - coreAlpha);
  if (a < 0.002) discard;
  vec3 color = mix(u_ink, u_accent, clamp(1.1 * g, 0.0, 1.0));
  outColor = vec4(color * a, a * (1.0 - 0.5 * u_additive));
}
`;
