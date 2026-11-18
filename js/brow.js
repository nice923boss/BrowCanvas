// Parametric eyebrow: three key points (head 眉頭, peak 眉峰, tail 眉尾) in
// image pixels, thickness at each, arch sharpness and colour, plus a transform
// (scale, rotate, dx, dy) around the head-tail midpoint. Geometry is pure;
// drawBrow() needs a canvas.

import { add, clamp, dist, lerp, lerpP, mid, mul, norm, rng, rotate, sub, upNormal, bbox } from './geom.js';

// Shapes in a normalised frame: brow length 1, head at x 0, tail at x 1.
// peakY / tailRise are heights above the head-tail line; thickness in brow lengths.
export const PRESETS = [
  { id: 'natural', name: '自然標準眉', peakX: 0.66, peakY: 0.1, tailRise: 0.02, tH: 0.16, tP: 0.13, tT: 0.035, arch: 0.45, headFade: 0.55, hair: 0.55, color: '#5a4636' },
  { id: 'straight', name: '韓系平眉', peakX: 0.62, peakY: 0.035, tailRise: -0.005, tH: 0.17, tP: 0.15, tT: 0.06, arch: 0.15, headFade: 0.5, hair: 0.5, color: '#5d4a3c' },
  { id: 'willow', name: '柳葉眉', peakX: 0.6, peakY: 0.13, tailRise: -0.03, tH: 0.11, tP: 0.1, tT: 0.02, arch: 0.3, headFade: 0.6, hair: 0.4, color: '#5a4636' },
  { id: 'lifted', name: '上揚挑眉', peakX: 0.72, peakY: 0.19, tailRise: 0.06, tH: 0.15, tP: 0.125, tT: 0.03, arch: 0.75, headFade: 0.5, hair: 0.55, color: '#4d3b2e' },
  { id: 'arched', name: '拱形眉', peakX: 0.55, peakY: 0.17, tailRise: -0.04, tH: 0.13, tP: 0.12, tT: 0.03, arch: 0.1, headFade: 0.55, hair: 0.45, color: '#5a4636' },
  { id: 'sword', name: '劍眉', peakX: 0.76, peakY: 0.15, tailRise: 0.1, tH: 0.18, tP: 0.15, tT: 0.04, arch: 0.85, headFade: 0.3, hair: 0.6, color: '#3e3027' },
  { id: 'wild', name: '野生眉', peakX: 0.64, peakY: 0.08, tailRise: 0.0, tH: 0.19, tP: 0.17, tT: 0.06, arch: 0.35, headFade: 0.45, hair: 0.95, color: '#4f3e31', soft: 0.25 },
];

export const COLORS = [
  { name: '深咖啡', value: '#3e3027' },
  { name: '自然棕', value: '#5a4636' },
  { name: '灰棕', value: '#5e5650' },
  { name: '奶茶棕', value: '#7a5e48' },
  { name: '霧灰', value: '#4a4a4c' },
  { name: '黑褐', value: '#2b2420' },
];

const SHAPE_KEYS = ['tH', 'tP', 'tT', 'arch', 'upper', 'color', 'opacity', 'soft', 'hair', 'headFade', 'scale', 'preset', 'visible'];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

// Build a brow from a preset, anchored on head and tail points.
export function browFromPreset(preset, head, tail, peakX = preset.peakX) {
  const d = sub(tail, head);
  const L = Math.hypot(d[0], d[1]) || 1;
  const up = upNormal(norm(d));
  const tailLifted = add(tail, mul(up, preset.tailRise * L));
  const d2 = sub(tailLifted, head);
  const peak = add(add(head, mul(d2, peakX)), mul(upNormal(norm(d2)), preset.peakY * L));
  return {
    preset: preset.id,
    head,
    peak,
    tail: tailLifted,
    tH: preset.tH * L,
    tP: preset.tP * L,
    tT: preset.tT * L,
    arch: preset.arch,
    upper: 0.5,
    color: preset.color,
    opacity: 0.78,
    soft: preset.soft ?? 0.45,
    hair: preset.hair,
    headFade: preset.headFade,
    scale: 1,
    rotate: 0,
    dx: 0,
    dy: 0,
    visible: true,
  };
}

// Keep a brow's look but take another preset's shape (same head/tail anchors).
export function applyPresetShape(brow, preset) {
  const fresh = browFromPreset(preset, brow.head, brow.tail, preset.peakX);
  return { ...fresh, color: brow.color, opacity: brow.opacity, scale: brow.scale, rotate: brow.rotate, dx: brow.dx, dy: brow.dy, visible: brow.visible };
}

// ---------- derived values for sliders ----------

// Peak position along head -> tail (0..1) and peak height (in brow lengths).
export function peakMetrics(b) {
  const d = sub(b.tail, b.head);
  const L2 = d[0] * d[0] + d[1] * d[1] || 1;
  const L = Math.sqrt(L2);
  const v = sub(b.peak, b.head);
  const up = upNormal(norm(d));
  return { along: (v[0] * d[0] + v[1] * d[1]) / L2, height: (v[0] * up[0] + v[1] * up[1]) / L, length: L };
}

export function withPeak(b, along, height) {
  const d = sub(b.tail, b.head);
  const L = Math.hypot(d[0], d[1]) || 1;
  const up = upNormal(norm(d));
  return { ...b, peak: add(add(b.head, mul(d, along)), mul(up, height * L)) };
}

// Tail height relative to the head, measured along the face vertical (`up`).
export function tailRise(b, up = [0, -1]) {
  const v = sub(b.tail, b.head);
  return v[0] * up[0] + v[1] * up[1];
}

export function withTailRise(b, rise, up = [0, -1]) {
  const cur = tailRise(b, up);
  const delta = mul(up, rise - cur);
  // Move the peak half as much, so the arch keeps its character.
  return { ...b, tail: add(b.tail, delta), peak: add(b.peak, mul(delta, 0.5)) };
}

// ---------- transform ----------

export function centreOf(b) {
  return mid(b.head, b.tail);
}

export function toWorld(b, p) {
  const c = centreOf(b);
  const r = rotate(mul(sub(p, c), b.scale), (b.rotate * Math.PI) / 180);
  return [c[0] + r[0] + b.dx, c[1] + r[1] + b.dy];
}

export function toLocal(b, p) {
  const c = centreOf(b);
  const v = rotate(sub(p, [c[0] + b.dx, c[1] + b.dy]), (-b.rotate * Math.PI) / 180);
  return add(c, mul(v, 1 / (b.scale || 1)));
}

// ---------- outline ----------

function hermite(p0, m0, p1, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [
    h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0],
    h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1],
  ];
}

const smooth = (t) => t * t * (3 - 2 * t);

// Spine and both edges in local (untransformed) coordinates, head -> tail.
export function outlineLocal(b, samples = 48) {
  const { head: H, peak: P, tail: T } = b;
  const a = clamp(b.arch, 0, 1);
  const smoothTan = mul(sub(T, H), 0.5);
  const m0 = sub(P, H);
  const mP1 = lerpP(smoothTan, sub(P, H), a);
  const mP2 = lerpP(smoothTan, sub(T, P), a);
  const m2 = sub(T, P);
  const l1 = dist(H, P);
  const l2 = dist(P, T);
  const sp = l1 / (l1 + l2 || 1);
  const spine = [];
  const thick = [];
  const ss = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    let p;
    let w;
    if (s <= sp) {
      const t = sp > 0 ? s / sp : 0;
      p = hermite(H, m0, P, mP1, t);
      w = lerp(b.tH, b.tP, smooth(t));
    } else {
      const t = (s - sp) / (1 - sp || 1);
      p = hermite(P, mP2, T, m2, t);
      // Taper faster towards the end of the tail.
      w = lerp(b.tP, b.tT, Math.pow(t, 1.6));
    }
    spine.push(p);
    thick.push(w);
    ss.push(s);
  }
  const upper = [];
  const lower = [];
  const u = clamp(b.upper ?? 0.5, 0.1, 0.9);
  for (let i = 0; i < spine.length; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(spine.length - 1, i + 1)];
    const n = upNormal(norm(sub(next, prev)));
    upper.push(add(spine[i], mul(n, thick[i] * u)));
    lower.push(sub(spine[i], mul(n, thick[i] * (1 - u))));
  }
  return { spine, upper, lower, thick, s: ss, sp };
}

// Closed polygon in world coordinates: a slightly rounded head, upper edge to
// the tail, lower edge back.
export function outline(b, samples = 48) {
  const o = outlineLocal(b, samples);
  const headCap = [];
  const u0 = o.upper[0];
  const l0 = o.lower[0];
  const back = norm(sub(o.spine[0], o.spine[2]));
  const r = o.thick[0] * 0.18;
  for (let k = 1; k < 4; k++) {
    const t = k / 4;
    const p = lerpP(l0, u0, t);
    headCap.push(add(p, mul(back, r * Math.sin(Math.PI * t))));
  }
  const local = [...headCap, ...o.upper, ...[...o.lower].reverse()];
  const w = (p) => toWorld(b, p);
  return {
    polygon: local.map(w),
    spine: o.spine.map(w),
    upper: o.upper.map(w),
    lower: o.lower.map(w),
    thick: o.thick.map((t) => t * b.scale),
    s: o.s,
    sp: o.sp,
  };
}

export function handles(b) {
  return { head: toWorld(b, b.head), peak: toWorld(b, b.peak), tail: toWorld(b, b.tail) };
}

export function browBox(b, pad = 0) {
  const bb = bbox(outline(b, 24).polygon);
  return { x1: bb.x1 - pad, y1: bb.y1 - pad, x2: bb.x2 + pad, y2: bb.y2 + pad };
}

// ---------- mirroring (linked left/right) ----------

// Mirror a brow across the face midline (a -> b). dy is per side and is kept
// by the caller.
export function mirrorBrow(src, a, bPt) {
  const flip = (p) => {
    const d = norm(sub(bPt, a));
    const v = sub(p, a);
    const along = v[0] * d[0] + v[1] * d[1];
    return sub(add(a, mul(d, 2 * along)), v);
  };
  const dLine = norm(sub(bPt, a));
  const dxv = [src.dx, src.dy];
  const along = dxv[0] * dLine[0] + dxv[1] * dLine[1];
  const md = sub(mul(dLine, 2 * along), dxv);
  return { ...src, head: flip(src.head), peak: flip(src.peak), tail: flip(src.tail), rotate: -src.rotate, dx: md[0], dy: md[1] };
}

export function copyShape(target, src) {
  const out = { ...target };
  for (const k of SHAPE_KEYS) if (k in src) out[k] = src[k];
  return out;
}

// ---------- drawing (browser) ----------

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  const n = m ? parseInt(m[1], 16) : 0x5a4636;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function pathOf(ctx, poly, ox, oy) {
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p[0] - ox, p[1] - oy) : ctx.moveTo(p[0] - ox, p[1] - oy)));
  ctx.closePath();
}

// Draw a brow onto ctx (in image coordinates; ctx may carry a view transform).
// `seed` keeps the hair strokes identical on every peer.
export function drawBrow(ctx, b, seed = 1) {
  if (!b || b.visible === false) return;
  const o = outline(b, 48);
  const avgT = o.thick.reduce((m, t) => m + t, 0) / o.thick.length;
  const pad = Math.ceil(avgT * 1.2 + 8);
  const bb = bbox(o.polygon);
  const ox = Math.floor(bb.x1 - pad);
  const oy = Math.floor(bb.y1 - pad);
  const w = Math.ceil(bb.x2 - bb.x1 + pad * 2);
  const h = Math.ceil(bb.y2 - bb.y1 + pad * 2);
  if (w <= 0 || h <= 0 || w > 4000 || h > 4000) return;
  const [r, g, bl] = hexToRgb(b.color);
  const rgba = (a) => `rgba(${r},${g},${bl},${a})`;
  const head = o.spine[0];
  const tail = o.spine[o.spine.length - 1];

  const off = makeCanvas(w, h);
  const c = off.getContext('2d');
  // 1. soft base fill: lighter at the head, full at the body, fading tail.
  const grad = c.createLinearGradient(head[0] - ox, head[1] - oy, tail[0] - ox, tail[1] - oy);
  const hf = clamp(b.headFade ?? 0.5, 0, 1);
  grad.addColorStop(0, rgba(0.85 - hf * 0.6));
  grad.addColorStop(Math.min(0.35, o.sp * 0.5), rgba(0.85));
  grad.addColorStop(Math.max(0.4, o.sp), rgba(0.95));
  grad.addColorStop(0.92, rgba(0.8));
  grad.addColorStop(1, rgba(0.55));
  const blurPx = Math.max(0.6, (b.soft ?? 0.45) * avgT * 0.22);
  c.filter = `blur(${blurPx.toFixed(2)}px)`;
  c.fillStyle = grad;
  pathOf(c, o.polygon, ox, oy);
  c.fill();
  c.filter = 'none';

  // 2. hair strokes: lower hairs point up towards the tail, upper hairs down,
  // head hairs stand up. Clipped to a slightly grown outline.
  const hair = clamp(b.hair ?? 0.5, 0, 1);
  if (hair > 0.02) {
    const rand = rng(seed);
    c.save();
    pathOf(c, o.polygon, ox, oy);
    c.clip();
    const count = Math.round((o.spine.length * avgT * 0.9 + 40) * hair);
    c.lineCap = 'round';
    for (let k = 0; k < count; k++) {
      const s = rand();
      const i = Math.min(o.spine.length - 2, Math.floor(s * (o.spine.length - 1)));
      const sp = o.spine[i];
      const tangent = norm(sub(o.spine[i + 1], sp));
      const n = upNormal(tangent);
      const across = rand() * 2 - 1; // -1 lower edge .. 1 upper edge
      const tw = o.thick[i];
      const base = add(sp, mul(n, (across * tw) / 2));
      const headZone = clamp(1 - s / 0.22, 0, 1);
      // angle from the tangent: head ~70deg, body ~25deg (sign by half), tail ~10deg
      const bodyAng = lerp(28, 10, clamp((s - 0.5) / 0.5, 0, 1)) * (across > 0 ? -1 : 1);
      const ang = ((lerp(bodyAng, 72, headZone) + (rand() - 0.5) * 14) * Math.PI) / 180;
      // positive angle turns from the tangent towards the forehead
      const dir = add(mul(tangent, Math.cos(ang)), mul(n, Math.sin(ang)));
      const lenH = tw * lerp(0.55, 0.9, rand()) * (headZone > 0 ? 0.8 : 1);
      const end = add(base, mul(dir, lenH));
      c.strokeStyle = rgba(lerp(0.25, 0.6, rand()) * (1 - headZone * hf * 0.5));
      c.lineWidth = Math.max(0.6, tw * lerp(0.05, 0.09, rand()));
      c.beginPath();
      c.moveTo(base[0] - ox, base[1] - oy);
      c.quadraticCurveTo(
        lerp(base[0], end[0], 0.5) + n[0] * tw * 0.05 - ox,
        lerp(base[1], end[1], 0.5) + n[1] * tw * 0.05 - oy,
        end[0] - ox,
        end[1] - oy,
      );
      c.stroke();
    }
    c.restore();
  }

  // 3. composite: multiply keeps skin texture, a little normal blend adds depth.
  const op = clamp(b.opacity ?? 0.78, 0, 1);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = op;
  ctx.drawImage(off, ox, oy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = op * 0.22;
  ctx.drawImage(off, ox, oy);
  ctx.restore();
}

// Small preview of a preset for the style picker (an SVG path string).
export function presetPath(preset, w = 96, h = 40) {
  const b = browFromPreset(preset, [w * 0.1, h * 0.66], [w * 0.9, h * 0.66]);
  const poly = outline(b, 24).polygon;
  return poly.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + 'Z';
}
