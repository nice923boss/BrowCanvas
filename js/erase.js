// Brow removal ("去眉"), adapted from EditP's erase(): work on a local crop with
// context around the regions, mask every region in that crop so hair is never
// the context a fill copies from, fill only masked pixels, leave the rest
// untouched. EditP fills with LaMa (Python, GPU) or OpenCV Telea; in the
// browser this uses a push-pull (masked pyramid) fill for smooth skin tone and
// then puts back skin texture reflected from just above / below the mask.
//
// Pure functions on RGBA byte arrays, so every peer computes the same result
// and Node tests can run them.

import { bbox, clamp, pointInPolygon } from './geom.js';

export const ERASE_DEFAULTS = {
  auto: true, // mask the detected brows
  expand: 0.45, // search area around the detected brow, in brow thicknesses
  sens: 14, // a pixel this much darker than the surrounding skin counts as hair
  grow: 2, // px added around the final mask (antialiased hair edges)
  texture: 0.85, // amount of skin texture put back into the fill
};

// ---------- mask helpers ----------

function rasterPolygon(poly, x0, y0, w, h, out) {
  const bb = bbox(poly);
  const xa = Math.max(0, Math.floor(bb.x1 - x0));
  const xb = Math.min(w - 1, Math.ceil(bb.x2 - x0));
  const ya = Math.max(0, Math.floor(bb.y1 - y0));
  const yb = Math.min(h - 1, Math.ceil(bb.y2 - y0));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      if (pointInPolygon([x + x0 + 0.5, y + y0 + 0.5], poly)) out[y * w + x] = 1;
    }
  }
}

function stampCircle(mask, w, h, cx, cy, r, value) {
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(w - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = value;
    }
  }
}

function stampStroke(mask, w, h, x0, y0, stroke) {
  const v = stroke.mode === 'remove' ? 0 : 1;
  const pts = stroke.pts;
  const r = stroke.r;
  const step = Math.max(1, r * 0.35);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1] ?? a;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      stampCircle(mask, w, h, a[0] + (b[0] - a[0]) * t - x0, a[1] + (b[1] - a[1]) * t - y0, r, v);
    }
  }
}

// Square (Chebyshev) dilation, separable.
export function dilate(src, w, h, r) {
  if (r <= 0) return src.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // two sweeps give the nearest set pixel on each side
    let prev = -Infinity;
    for (let x = 0; x < w; x++) {
      if (src[y * w + x]) prev = x;
      if (x - prev <= r) tmp[y * w + x] = 1;
    }
    let next = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (src[y * w + x]) next = x;
      if (next - x <= r) tmp[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let prev = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) prev = y;
      if (y - prev <= r) out[y * w + x] = 1;
    }
    let next = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) next = y;
      if (next - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    let n = 0;
    for (let x = -r; x < w; x++) {
      const add = x + r;
      if (add < w) {
        acc += src[y * w + add];
        n++;
      }
      const drop = x - r - 1;
      if (drop >= 0) {
        acc -= src[y * w + drop];
        n--;
      }
      if (x >= 0) tmp[y * w + x] = acc / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    let n = 0;
    for (let y = -r; y < h; y++) {
      const add = y + r;
      if (add < h) {
        acc += tmp[add * w + x];
        n++;
      }
      const drop = y - r - 1;
      if (drop >= 0) {
        acc -= tmp[drop * w + x];
        n--;
      }
      if (y >= 0) out[y * w + x] = acc / n;
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return 128;
  const hist = new Uint32Array(256);
  for (const v of values) hist[v | 0]++;
  let k = values.length / 2;
  for (let i = 0; i < 256; i++) {
    k -= hist[i];
    if (k <= 0) return i;
  }
  return 255;
}

// ---------- push-pull fill ----------

// Fill pixels where known[i] == 0 from the known ones. Colour is carried
// premultiplied by its weight through the pyramid, then normalised.
export function pushPull(rgb, known, w, h) {
  const levels = [];
  let c = new Float32Array(w * h * 3);
  let wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = known[i] ? 1 : 0;
    wt[i] = k;
    c[i * 3] = rgb[i * 3] * k;
    c[i * 3 + 1] = rgb[i * 3 + 1] * k;
    c[i * 3 + 2] = rgb[i * 3 + 2] * k;
  }
  let lw = w;
  let lh = h;
  levels.push({ c, wt, w: lw, h: lh });
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, Math.ceil(lw / 2));
    const nh = Math.max(1, Math.ceil(lh / 2));
    const nc = new Float32Array(nw * nh * 3);
    const nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sw = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = 2 * y + dy;
          if (yy >= lh) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            if (xx >= lw) continue;
            const j = yy * lw + xx;
            sw += wt[j];
            r += c[j * 3];
            g += c[j * 3 + 1];
            b += c[j * 3 + 2];
          }
        }
        const i = y * nw + x;
        if (sw > 0) {
          const nwv = Math.min(1, sw);
          const k = nwv / sw;
          nwt[i] = nwv;
          nc[i * 3] = r * k;
          nc[i * 3 + 1] = g * k;
          nc[i * 3 + 2] = b * k;
        }
      }
    }
    c = nc;
    wt = nwt;
    lw = nw;
    lh = nh;
    levels.push({ c, wt, w: lw, h: lh });
  }
  // coarsest: normalise
  const top = levels[levels.length - 1];
  for (let i = 0; i < top.w * top.h; i++) {
    const s = top.wt[i];
    if (s > 0 && s < 1) {
      top.c[i * 3] /= s;
      top.c[i * 3 + 1] /= s;
      top.c[i * 3 + 2] /= s;
      top.wt[i] = 1;
    }
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l];
    const co = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const cy = clamp((y + 0.5) / 2 - 0.5, 0, co.h - 1);
      const y0 = Math.floor(cy);
      const y1 = Math.min(co.h - 1, y0 + 1);
      const ty = cy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const miss = 1 - f.wt[i];
        if (miss <= 0) continue;
        const cx = clamp((x + 0.5) / 2 - 0.5, 0, co.w - 1);
        const x0 = Math.floor(cx);
        const x1 = Math.min(co.w - 1, x0 + 1);
        const tx = cx - x0;
        const a = y0 * co.w + x0;
        const b = y0 * co.w + x1;
        const cc = y1 * co.w + x0;
        const d = y1 * co.w + x1;
        const wa = (1 - tx) * (1 - ty);
        const wb = tx * (1 - ty);
        const wc = (1 - tx) * ty;
        const wd = tx * ty;
        const ww = co.wt[a] * wa + co.wt[b] * wb + co.wt[cc] * wc + co.wt[d] * wd;
        for (let ch = 0; ch < 3; ch++) {
          const v = co.c[a * 3 + ch] * wa + co.c[b * 3 + ch] * wb + co.c[cc * 3 + ch] * wc + co.c[d * 3 + ch] * wd;
          f.c[i * 3 + ch] += miss * v;
        }
        f.wt[i] += miss * ww;
      }
    }
  }
  const base = levels[0];
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const s = base.wt[i] || 1;
    out[i * 3] = base.c[i * 3] / s;
    out[i * 3 + 1] = base.c[i * 3 + 1] / s;
    out[i * 3 + 2] = base.c[i * 3 + 2] / s;
  }
  return out;
}

// ---------- main entry ----------

// regions: [{ polygon, thick }] detected brows (used when opts.auto)
// strokes: [{ mode: 'add' | 'remove', r, pts: [[x, y], ...] }] in image pixels
// Returns { x, y, w, h, data (RGBA crop), mask } or null when nothing is masked.
export function eraseBrows(img, regions, strokes, opts = {}) {
  const o = { ...ERASE_DEFAULTS, ...opts };
  const W = img.width;
  const H = img.height;
  const useRegions = o.auto ? regions ?? [] : [];
  const addStrokes = (strokes ?? []).filter((s) => s.pts?.length);
  if (!useRegions.length && !addStrokes.some((s) => s.mode !== 'remove')) return null;

  // crop box
  const boxes = [];
  for (const r of useRegions) {
    const bb = bbox(r.polygon);
    const e = r.thick * o.expand + 12;
    boxes.push({ x1: bb.x1 - e, y1: bb.y1 - e, x2: bb.x2 + e, y2: bb.y2 + e });
  }
  for (const s of addStrokes) {
    const bb = bbox(s.pts);
    boxes.push({ x1: bb.x1 - s.r, y1: bb.y1 - s.r, x2: bb.x2 + s.r, y2: bb.y2 + s.r });
  }
  const ctxPad = 32;
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x1)) - ctxPad));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y1)) - ctxPad));
  const x1 = Math.min(W, Math.ceil(Math.max(...boxes.map((b) => b.x2)) + ctxPad));
  const y1 = Math.min(H, Math.ceil(Math.max(...boxes.map((b) => b.y2)) + ctxPad));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 2 || h <= 2) return null;

  const n = w * h;
  const rgb = new Float32Array(n * 3);
  const lum = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + y0) * W + (x + x0)) * 4;
      const i = y * w + x;
      const r = img.data[si];
      const g = img.data[si + 1];
      const b = img.data[si + 2];
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
      lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    }
  }

  let mask = new Uint8Array(n);
  for (const r of useRegions) {
    const core = new Uint8Array(n);
    rasterPolygon(r.polygon, x0, y0, w, h, core);
    const e = Math.max(3, Math.round(r.thick * o.expand));
    const area = dilate(core, w, h, e);
    const ring = dilate(core, w, h, e + 8);
    const skin = [];
    for (let i = 0; i < n; i++) if (ring[i] && !area[i]) skin.push(lum[i]);
    const skinLum = median(skin);
    const coreGrown = dilate(core, w, h, 1);
    for (let i = 0; i < n; i++) {
      if (coreGrown[i] || (area[i] && lum[i] < skinLum - o.sens)) mask[i] = 1;
    }
  }
  if (o.grow > 0) mask = dilate(mask, w, h, o.grow);
  for (const s of addStrokes) stampStroke(mask, w, h, x0, y0, s);

  let any = false;
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      any = true;
      break;
    }
  }
  if (!any) return null;

  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) known[i] = mask[i] ? 0 : 1;
  const fill = pushPull(rgb, known, w, h);

  // skin texture: high-pass of the original, reflected from the nearest
  // unmasked rows above the masked run (forehead), else below it.
  const tex = o.texture;
  const hp = new Float32Array(n * 3);
  if (tex > 0) {
    for (let ch = 0; ch < 3; ch++) {
      const plane = new Float32Array(n);
      for (let i = 0; i < n; i++) plane[i] = rgb[i * 3 + ch];
      const blur = boxBlur(plane, w, h, 3);
      for (let i = 0; i < n; i++) hp[i * 3 + ch] = plane[i] - blur[i];
    }
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) {
        y++;
        continue;
      }
      const top = y;
      while (y < h && mask[y * w + x]) y++;
      const bot = y - 1;
      for (let yy = top; yy <= bot; yy++) {
        const i = yy * w + x;
        let src = -1;
        const up = top - 2 - (yy - top);
        if (up >= 0 && !mask[up * w + x]) src = up * w + x;
        else {
          const dn = bot + 2 + (bot - yy);
          if (dn < h && !mask[dn * w + x]) src = dn * w + x;
        }
        for (let ch = 0; ch < 3; ch++) {
          const t = src >= 0 ? hp[src * 3 + ch] * tex : 0;
          fill[i * 3 + ch] += t;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const m = mask[i];
    out[i * 4] = m ? fill[i * 3] : rgb[i * 3];
    out[i * 4 + 1] = m ? fill[i * 3 + 1] : rgb[i * 3 + 1];
    out[i * 4 + 2] = m ? fill[i * 3 + 2] : rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return { x: x0, y: y0, w, h, data: out, mask };
}
