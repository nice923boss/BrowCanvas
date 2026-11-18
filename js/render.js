// Drawing of the composed picture: photo (or white paper), erased brows, new
// brows and the guide layers. Everything is drawn in image coordinates; the
// caller sets the view transform and passes its scale so lines stay crisp.

import { drawBrow, handles, centreOf, toWorld, outline } from './brow.js';
import { guidesFor, anchorsFor } from './face.js';
import { add, dist, dot, mul, norm, sub, upNormal, lerp, lerpP, bbox } from './geom.js';

export const LAYER_STYLE = {
  oval: { color: '#ff7a59', label: '臉型輪廓' },
  eyes: { color: '#2f9cf0', label: '眼睛' },
  origBrow: { color: '#e0a400', label: '原生眉' },
  ears: { color: '#9b6ee8', label: '耳朵（估計）' },
  noseMouth: { color: '#21a67a', label: '鼻子、嘴巴' },
  guides: { color: '#ec407a', label: '眉型定位線' },
  thirds: { color: '#7d8590', label: '三庭五眼' },
};

export const SEEDS = { L: 11, R: 23 };

function poly(ctx, pts, close = true) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}

function dot2(ctx, p, r) {
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fill();
}

function label(ctx, text, p, px, color, align = 'left') {
  ctx.save();
  ctx.font = `600 ${px}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = px * 0.28;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeText(text, p[0], p[1]);
  ctx.fillStyle = color;
  ctx.fillText(text, p[0], p[1]);
  ctx.restore();
}

function styled(ctx, color, lw, dash) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash(dash ? [lw * 4, lw * 3] : []);
}

// Lines from the nose wing through each reference, up to a little above the brow.
function guideSegment(f, s, g) {
  const b = f[s].brow;
  const top = dot(sub(b.head, g.from), f.up) + b.thick * 3;
  const k = dot(g.dir, f.up);
  const t = k > 0.05 ? top / k : dist(g.from, g.through) * 2;
  return [g.from, add(g.from, mul(g.dir, t))];
}

export function drawOverlays(ctx, f, layers, peakRule, vs, sketch) {
  if (!f) return;
  const lw = 1.6 / vs;
  const fs = 12 / vs;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const on = (k) => layers[k];
  const col = (k) => LAYER_STYLE[k].color;
  const width = sketch ? lw * 1.4 : lw;

  if (on('thirds')) {
    styled(ctx, col('thirds'), width, true);
    const { hairline, brow, nose, chin } = f.thirds;
    const half = f.faceW * 0.62;
    const names = [['髮際（估計）', hairline], ['眉', brow], ['鼻底', nose], ['下巴', chin]];
    for (const [name, p] of names) {
      const c = add(f.midline[0], mul(f.hor, dot(sub(p, f.midline[0]), f.hor)));
      const base = add(c, mul(f.up, dot(sub(p, c), f.up)));
      const a = sub(base, mul(f.hor, half));
      poly(ctx, [a, add(base, mul(f.hor, half))], false);
      ctx.stroke();
      label(ctx, name, sub(a, mul(f.hor, fs * 0.4)), fs, col('thirds'), 'right');
    }
    // five eyes: face edges, outer and inner eye corners
    const xs = [f.L.cheek, f.L.outer, f.L.inner, f.R.inner, f.R.outer, f.R.cheek];
    for (const p of xs) {
      poly(ctx, [add(p, mul(f.up, f.faceW * 0.25)), sub(p, mul(f.up, f.faceW * 0.12))], false);
      ctx.stroke();
    }
  }
  if (on('oval')) {
    styled(ctx, col('oval'), width, true);
    poly(ctx, f.oval);
    ctx.stroke();
  }
  if (on('ears')) {
    styled(ctx, col('ears'), width, true);
    for (const s of ['L', 'R']) {
      const e = f.ears[s];
      const ang = Math.atan2(f.hor[1], f.hor[0]);
      ctx.beginPath();
      ctx.ellipse(e.centre[0], e.centre[1], e.rx, e.ry, ang, 0, Math.PI * 2);
      ctx.stroke();
    }
    label(ctx, '耳（估計）', add(f.ears.R.centre, mul(f.hor, f.ears.R.rx + fs * 0.4)), fs, col('ears'));
  }
  if (on('eyes')) {
    styled(ctx, col('eyes'), width, true);
    for (const s of ['L', 'R']) {
      poly(ctx, f[s].eye);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(f[s].iris.c[0], f[s].iris.c[1], f[s].iris.r, 0, Math.PI * 2);
      ctx.stroke();
      dot2(ctx, f[s].iris.c, lw * 1.4);
    }
  }
  if (on('noseMouth')) {
    styled(ctx, col('noseMouth'), width, true);
    poly(ctx, f.noseBridge, false);
    ctx.stroke();
    poly(ctx, [f.L.wing, ...f.noseBase, f.R.wing], false);
    ctx.stroke();
    poly(ctx, f.lips);
    ctx.stroke();
  }
  if (on('origBrow')) {
    styled(ctx, col('origBrow'), width, true);
    for (const s of ['L', 'R']) {
      poly(ctx, f[s].brow.polygon);
      ctx.stroke();
    }
  }
  if (on('guides')) {
    styled(ctx, col('guides'), width, true);
    for (const s of ['L', 'R']) {
      const g = guidesFor(f, s, peakRule);
      for (const key of ['head', 'peak', 'tail']) {
        poly(ctx, guideSegment(f, s, g[key]), false);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const a = anchorsFor(f, s, peakRule);
      dot2(ctx, a.head, lw * 2.4);
      dot2(ctx, a.tail, lw * 2.4);
      dot2(ctx, f[s].wing, lw * 2.4);
      // tail should not drop below the head: the horizontal through the head
      ctx.setLineDash([lw * 1.5, lw * 3]);
      poly(ctx, [a.head, a.tail], false);
      ctx.stroke();
      ctx.setLineDash([lw * 4, lw * 3]);
    }
    const gR = guidesFor(f, 'R', peakRule);
    const segs = ['head', 'peak', 'tail'].map((k) => guideSegment(f, 'R', gR[k])[1]);
    label(ctx, '眉頭', segs[0], fs, col('guides'), 'center');
    label(ctx, '眉峰', segs[1], fs, col('guides'), 'center');
    label(ctx, '眉尾', segs[2], fs, col('guides'), 'center');
  }
  ctx.restore();
}

// Key point handles and the rotate knob of the selected plan.
export function rotateKnob(b) {
  const up = upNormal(norm(sub(b.tail, b.head)));
  return toWorld(b, add(centreOf(b), mul(up, Math.max(b.tP * 1.8, 22))));
}

export function drawHandles(ctx, brows, selSide, vs) {
  const r = 7 / vs;
  ctx.save();
  for (const s of ['L', 'R']) {
    const b = brows[s];
    if (!b || b.visible === false) continue;
    const sel = s === selSide;
    const h = handles(b);
    const o = outline(b, 24);
    ctx.setLineDash(sel ? [] : [4 / vs, 4 / vs]);
    ctx.lineWidth = (sel ? 1.6 : 1) / vs;
    ctx.strokeStyle = sel ? 'rgba(0,140,255,0.9)' : 'rgba(255,255,255,0.7)';
    poly(ctx, o.polygon);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!sel) continue;
    const knob = rotateKnob(b);
    const c = toWorld(b, centreOf(b));
    ctx.strokeStyle = 'rgba(0,140,255,0.9)';
    poly(ctx, [c, knob], false);
    ctx.stroke();
    const pts = [
      [h.head, '#ffffff', '頭'],
      [h.peak, '#ffffff', '峰'],
      [h.tail, '#ffffff', '尾'],
      [knob, '#bfe1ff', '轉'],
    ];
    for (const [p, fill, name] of pts) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2 / vs;
      ctx.strokeStyle = '#0a84ff';
      ctx.stroke();
      ctx.font = `700 ${9 / vs}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
      ctx.fillStyle = '#0a5cc2';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, p[0], p[1] + 0.5 / vs);
    }
  }
  ctx.restore();
}

// scene: { img, w, h, erased: { canvas, x, y } | null, f, layers, peakRule, brows }
// opt: { vs (view scale), overlays (bool), handles: side | null, eraseOn }
export function drawScene(ctx, scene, opt = {}) {
  const { img, w, h, erased, f, layers, brows } = scene;
  const vs = opt.vs ?? 1;
  ctx.save();
  ctx.fillStyle = layers.sketch ? '#ffffff' : '#d9d9d9';
  ctx.fillRect(0, 0, w, h);
  if (img && layers.photo) {
    ctx.globalAlpha = layers.sketch ? Math.min(layers.photoOpacity, 0.35) : layers.photoOpacity;
    ctx.drawImage(img, 0, 0, w, h);
    if (erased && opt.eraseOn !== false) ctx.drawImage(erased.canvas, erased.x, erased.y);
    ctx.globalAlpha = 1;
  }
  if (brows && layers.newBrow) {
    drawBrow(ctx, brows.L, SEEDS.L);
    drawBrow(ctx, brows.R, SEEDS.R);
  }
  if (opt.overlays !== false) drawOverlays(ctx, f, layers, scene.peakRule, vs, layers.sketch);
  if (brows && opt.handles && layers.handles && layers.newBrow) drawHandles(ctx, brows, opt.handles, vs);
  ctx.restore();
}

// Region around brows and eyes for comparison tiles.
export function browRegion(f, w, h) {
  if (!f) return { x: 0, y: 0, w, h };
  const pts = [...f.L.brow.polygon, ...f.R.brow.polygon, ...f.L.eye, ...f.R.eye, f.L.cheek, f.R.cheek];
  const bb = bbox(pts);
  const padX = (bb.x2 - bb.x1) * 0.06;
  const padY = (bb.y2 - bb.y1) * 0.55;
  const x = Math.max(0, bb.x1 - padX);
  const y = Math.max(0, bb.y1 - padY);
  return { x, y, w: Math.min(w, bb.x2 + padX) - x, h: Math.min(h, bb.y2 + padY * 0.8) - y };
}

// ---------- animation between received states ----------

const NUM_KEYS = ['tH', 'tP', 'tT', 'arch', 'upper', 'opacity', 'soft', 'hair', 'headFade', 'scale', 'rotate', 'dx', 'dy'];

export function lerpBrow(a, b, t) {
  if (!a || !b) return b;
  const out = { ...b, head: lerpP(a.head, b.head, t), peak: lerpP(a.peak, b.peak, t), tail: lerpP(a.tail, b.tail, t) };
  for (const k of NUM_KEYS) out[k] = lerp(a[k] ?? b[k], b[k], t);
  return out;
}

export function browGap(a, b) {
  if (!a || !b) return 0;
  let g = dist(a.head, b.head) + dist(a.peak, b.peak) + dist(a.tail, b.tail);
  for (const k of NUM_KEYS) g += Math.abs((a[k] ?? 0) - (b[k] ?? 0)) * (k === 'rotate' || k === 'dx' || k === 'dy' ? 1 : 20);
  return g;
}
