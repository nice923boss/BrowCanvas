// Canvas pointer input: move tool (drag head / peak / tail, body, rotate
// knob), smudge / restore brush strokes, pan, wheel and pinch zoom.
// `A` is the app context; drags go out through A.queue (one op per frame).

import { otherSide, dragPointPatches } from './state.js';
import { toWorld, centreOf, handles, outline, browBox } from './brow.js';
import { rotateKnob } from './render.js';
import { dist, clamp, pointInPolygon } from './geom.js';
import { toast, VIEW_ONLY } from './dom.js';

const angleOf = (c, p) => (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
const round2 = (p) => [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2];
const isBrush = (t) => t === 'smudge' || t === 'restore';

export function initPointer(A, view) {
  const { ui } = A;

  function hitTest(p) {
    const plan = A.activePlan();
    if (!plan?.brows || !A.state.layers.newBrow) return null;
    const tol = 12 / ui.view.s;
    const sel = plan.brows[ui.side];
    if (sel?.visible !== false && A.state.layers.handles) {
      if (dist(p, rotateKnob(sel)) < tol) return { type: 'rotate', side: ui.side };
      const h = handles(sel);
      for (const key of ['head', 'peak', 'tail']) if (dist(p, h[key]) < tol) return { type: 'point', side: ui.side, key };
    }
    const order = [ui.side, otherSide(ui.side)];
    for (const s of order) {
      const b = plan.brows[s];
      if (b?.visible !== false && pointInPolygon(p, outline(b, 24).polygon)) return { type: 'body', side: s };
    }
    for (const s of order) {
      const b = plan.brows[s];
      if (b?.visible === false) continue;
      const bb = browBox(b, tol);
      if (p[0] > bb.x1 && p[0] < bb.x2 && p[1] > bb.y1 && p[1] < bb.y2) return { type: 'body', side: s };
    }
    return null;
  }

  function startDrag(e, p) {
    const panning = ui.tool === 'pan' || ui.space || e.button === 1;
    if (!panning && isBrush(ui.tool)) {
      if (!A.state.landmarks) return null;
      if (!A.net.canEdit) {
        toast(VIEW_ONLY);
        return null;
      }
      ui.stroke = { mode: ui.tool === 'smudge' ? 'add' : 'remove', r: Math.round((ui.brush / ui.view.s) * 10) / 10, pts: [round2(p)] };
      A.redraw();
      return { type: 'stroke' };
    }
    if (!panning && ui.tool === 'move' && A.net.canEdit) {
      const hit = hitTest(p);
      if (hit) {
        if (hit.side !== ui.side) {
          ui.side = hit.side;
          A.syncPanels();
        }
        const plan = A.activePlan();
        const b = plan.brows[hit.side];
        const centre = toWorld(b, centreOf(b));
        return { ...hit, start: p, b0: b, o0: plan.brows[otherSide(hit.side)], centre, a0: angleOf(centre, p) };
      }
    }
    return { type: 'pan', sx: e.clientX, sy: e.clientY, v0: { ...ui.view } };
  }

  function moveDrag(d, e, p) {
    if (d.type === 'pan') {
      A.setView({ ...d.v0, x: d.v0.x + e.clientX - d.sx, y: d.v0.y + e.clientY - d.sy });
      return;
    }
    if (d.type === 'stroke') {
      const pts = ui.stroke.pts;
      if (dist(pts[pts.length - 1], p) > ui.stroke.r * 0.3) pts.push(round2(p));
      A.redraw();
      return;
    }
    const plan = A.activePlan();
    if (!plan?.brows) return;
    const s = d.side;
    const os = otherSide(s);
    if (d.type === 'point') {
      A.queue({ t: 'setBrows', plan: plan.id, patches: dragPointPatches(plan, s, d.key, p, A.F()), k: `drag:${plan.id}:${d.key}` });
    } else if (d.type === 'body') {
      const dx = p[0] - d.start[0];
      const dy = p[1] - d.start[1];
      const patches = { [s]: { dx: d.b0.dx + dx, dy: d.b0.dy + dy } };
      if (plan.link) patches[os] = { dx: d.o0.dx - dx }; // up/down stays per side
      A.queue({ t: 'setBrows', plan: plan.id, patches, k: `drag:${plan.id}:body` });
    } else if (d.type === 'rotate') {
      let da = angleOf(d.centre, p) - d.a0;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      const patches = { [s]: { rotate: clamp(d.b0.rotate + da, -45, 45) } };
      if (plan.link) patches[os] = { rotate: clamp(d.o0.rotate - da, -45, 45) };
      A.queue({ t: 'setBrows', plan: plan.id, patches, k: `drag:${plan.id}:rotate` });
    }
  }

  function endDrag(d) {
    if (d?.type === 'stroke' && ui.stroke) {
      const stroke = ui.stroke;
      ui.stroke = null;
      if (!A.state.erase.on) A.dispatch({ t: 'setErase', patch: { on: true } });
      A.dispatch({ t: 'addStroke', stroke });
      A.redraw();
    }
    A.flush();
  }

  const stagePoint = (e) => {
    const r = view.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function updateCursorStyle(p) {
    if (ui.tool === 'pan' || ui.space) view.style.cursor = 'grab';
    else if (ui.tool !== 'move') view.style.cursor = 'crosshair';
    else {
      const hit = A.net?.canEdit ? hitTest(p) : null;
      view.style.cursor = !hit ? 'grab' : hit.type === 'rotate' ? 'alias' : hit.type === 'point' ? 'pointer' : 'move';
    }
  }

  let lastCursorAt = 0;
  function sendCursor(p) {
    if (!A.net || A.net.role === 'solo') return;
    const now = performance.now();
    if (p && now - lastCursorAt < 70) return;
    lastCursorAt = now;
    A.net.cursor(p ? Math.round(p[0]) : null, p ? Math.round(p[1]) : null);
  }

  view.addEventListener('pointerdown', (e) => {
    if (!A.photoOf()) return;
    view.setPointerCapture(e.pointerId);
    ui.pointers.set(e.pointerId, stagePoint(e));
    if (ui.pointers.size === 2) {
      // second finger: pinch zoom replaces the single-finger action
      ui.stroke = null;
      ui.drag = null;
      const [a, b] = [...ui.pointers.values()];
      ui.pinch = { d0: dist(a, b), m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...ui.view } };
      A.redraw();
      return;
    }
    if (ui.pointers.size > 2) return;
    const [sx, sy] = stagePoint(e);
    ui.drag = startDrag(e, A.toImage(sx, sy));
  });

  view.addEventListener('pointermove', (e) => {
    const sp = stagePoint(e);
    const p = A.toImage(sp[0], sp[1]);
    ui.hover = p;
    sendCursor(p);
    if (ui.pointers.has(e.pointerId)) ui.pointers.set(e.pointerId, sp);
    if (ui.pinch && ui.pointers.size >= 2) {
      const [a, b] = [...ui.pointers.values()];
      const { v0, m0, d0 } = ui.pinch;
      const s = clamp(v0.s * (dist(a, b) / (d0 || 1)), 0.05, 40);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ix = (m0[0] - v0.x) / v0.s;
      const iy = (m0[1] - v0.y) / v0.s;
      A.setView({ s, x: m[0] - ix * s, y: m[1] - iy * s });
      return;
    }
    if (ui.drag) moveDrag(ui.drag, e, p);
    else {
      if (isBrush(ui.tool)) A.redraw();
      updateCursorStyle(p);
    }
  });

  function release(e) {
    ui.pointers.delete(e.pointerId);
    if (ui.pinch) {
      if (ui.pointers.size < 2) ui.pinch = null;
      return;
    }
    if (ui.drag) {
      endDrag(ui.drag);
      ui.drag = null;
    }
  }
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);
  view.addEventListener('pointerleave', () => {
    ui.hover = null;
    A.redraw();
    sendCursor(null);
  });
  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [sx, sy] = stagePoint(e);
      A.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
}
