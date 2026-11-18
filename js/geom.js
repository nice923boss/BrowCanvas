// Small 2D vector helpers. Points are [x, y] arrays in image pixels.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpP = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
export const mid = (a, b) => lerpP(a, b, 0.5);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function norm(a) {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : [1, 0];
}

export function rotate(a, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}

export const avg = (pts) => mul(pts.reduce((s, p) => add(s, p), [0, 0]), 1 / pts.length);

// Perpendicular of direction d that points up the image (towards smaller y).
export function upNormal(d) {
  const n = [d[1], -d[0]];
  return n[1] <= 0 ? n : [-n[0], -n[1]];
}

// Intersection of line (p, p + d) with line (q, q + e); null when parallel.
export function intersect(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return add(p, mul(d, t));
}

// Mirror point p across the line through a and b.
export function mirrorPoint(p, a, b) {
  const d = norm(sub(b, a));
  const v = sub(p, a);
  const proj = mul(d, dot(v, d));
  return sub(add(a, mul(proj, 2)), v);
}

// Mirror a direction vector across a line with direction d.
export function mirrorVector(v, d) {
  const u = norm(d);
  return sub(mul(u, 2 * dot(v, u)), v);
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bbox(pts) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  return { x1, y1, x2, y2 };
}

// Deterministic PRNG (mulberry32), so every peer draws the same hair strokes.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
