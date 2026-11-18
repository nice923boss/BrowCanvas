// BrowCanvas main: shared state, live session, photos, brow-removal cache,
// view and render loop. Shared state only changes through
// dispatch() -> net.op() -> applyOp(); view, tool and selection are local.
// UI modules get the context object `A` defined below.

import { initialState, TEACH_STEPS } from './state.js';
import { featuresFrom, detectFace } from './face.js';
import { PRESETS } from './brow.js';
import { eraseBrows } from './erase.js';
import { drawScene, browRegion, lerpBrow, browGap } from './render.js';
import { createNet, roomIdFrom } from './net.js';
import { newId } from './store.js';
import { clamp } from './geom.js';
import { $, $$, el, toast, VIEW_ONLY } from './dom.js';
import { decode, prepareUpload, initCamera } from './photo-io.js';
import { initPanels } from './panels.js';
import { initPointer } from './pointer.js';
import { initExport } from './exporter.js';
import { initRecords } from './records.js';
import { initSessionUI } from './session-ui.js';

const DEMO = { id: 'demo', url: 'assets/demo-model.jpg', landmarks: 'assets/demo-landmarks.json' };

// ---------- local identity ----------

function stored(kind, key, make) {
  try {
    const s = window[kind];
    let v = s.getItem(key);
    if (!v) {
      v = make();
      s.setItem(key, v);
    }
    return v;
  } catch {
    return make();
  }
}
const me = {
  id: stored('sessionStorage', 'browcanvas.id', () => `u${Math.random().toString(36).slice(2, 10)}`),
  name: stored('localStorage', 'browcanvas.name', () => `成員${Math.floor(Math.random() * 90 + 10)}`),
};
const room = roomIdFrom(location);

// ---------- state ----------

let state = initialState();
let net = null;
let feat = { lm: null, f: null };
const photos = new Map(); // id -> { meta, bytes, img, imageData }
const erased = { key: '', result: null, timer: 0 };
let shown = null; // { plan, L, R }: brows on screen, animated towards the state
let busy = '';
let demoDone = false;
let demoLandmarks = null;
let history = { canUndo: false, canRedo: false };
const cursors = new Map(); // id -> { name, color, x, y, at }
const pending = new Map(); // op key -> newest op, sent once a frame

const ui = {
  tool: 'move',
  side: 'L',
  brush: 16,
  view: { s: 1, x: 0, y: 0 },
  fittedFor: null,
  drag: null,
  stroke: null,
  hover: null,
  space: false,
  pointers: new Map(),
  pinch: null,
};

const F = () => {
  if (feat.lm !== state.landmarks) feat = { lm: state.landmarks, f: state.landmarks ? featuresFrom(state.landmarks) : null };
  return feat.f;
};
const activePlan = () => state.plans.find((p) => p.id === state.active) ?? state.plans[0];
const photoOf = () => (state.photo ? photos.get(state.photo.id) : photos.get(DEMO.id)) ?? null;

function dispatch(op) {
  if (!net.canEdit) {
    toast(VIEW_ONLY);
    return false;
  }
  return net.op(op);
}
function queue(op) {
  if (net.canEdit) pending.set(op.k, op);
}
function flush() {
  if (!pending.size) return;
  const ops = [...pending.values()];
  pending.clear();
  for (const op of ops) net.op(op);
}

// ---------- view ----------

const view = $('view');
const ctx = view.getContext('2d');
const curCanvas = $('cursors');
const cctx = curCanvas.getContext('2d');
const stage = $('stage');
let dpr = 1;
let dirty = true;
let cursorsDirty = true;
let compareDirty = true;

function redraw() {
  dirty = true;
  cursorsDirty = true;
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  for (const c of [view, curCanvas]) {
    c.width = Math.round(stage.clientWidth * dpr);
    c.height = Math.round(stage.clientHeight * dpr);
  }
  redraw();
}
new ResizeObserver(() => {
  const wasEmpty = view.width === 0;
  resize();
  if (ui.fittedFor && wasEmpty) fit();
}).observe(stage);

function setView(v) {
  ui.view = v;
  redraw();
}
function fitTo(x, y, w, h, margin = 0.94) {
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  if (!cw || !ch || !w || !h) return;
  const s = Math.min(cw / w, ch / h) * margin;
  setView({ s, x: cw / 2 - (x + w / 2) * s, y: ch / 2 - (y + h / 2) * s });
}
function fit() {
  const p = photoOf();
  if (p) fitTo(0, 0, p.meta.w, p.meta.h);
}
function zoomBrow() {
  const p = photoOf();
  const f = F();
  if (!p || !f) return;
  const r = browRegion(f, p.meta.w, p.meta.h);
  fitTo(r.x, r.y, r.w, r.h, 0.9);
}
const toImage = (sx, sy) => [(sx - ui.view.x) / ui.view.s, (sy - ui.view.y) / ui.view.s];
function zoomAt(sx, sy, k) {
  const s = clamp(ui.view.s * k, 0.05, 40);
  const [ix, iy] = toImage(sx, sy);
  setView({ s, x: sx - ix * s, y: sy - iy * s });
}

function snapShown() {
  const p = activePlan();
  shown = p?.brows ? { plan: p.id, L: p.brows.L, R: p.brows.R } : null;
  dirty = true;
}

// Ease the drawn brows towards the shared state so remote changes glide.
function stepAnim(dt) {
  const p = activePlan();
  if (!p?.brows) {
    if (shown) snapShown();
    return false;
  }
  if (!shown || shown.plan !== p.id) {
    snapShown();
    return false;
  }
  if (shown.L === p.brows.L && shown.R === p.brows.R) return false;
  if (browGap(shown.L, p.brows.L) + browGap(shown.R, p.brows.R) < 0.4) {
    snapShown();
    return true;
  }
  const t = 1 - Math.exp(-dt / 70);
  shown = { plan: p.id, L: lerpBrow(shown.L, p.brows.L, t), R: lerpBrow(shown.R, p.brows.R, t) };
  return true;
}

function sceneFor(brows) {
  const p = photoOf();
  return {
    img: p?.img ?? null,
    w: p?.meta.w ?? 768,
    h: p?.meta.h ?? 1024,
    erased: erased.result,
    f: F(),
    layers: state.layers,
    peakRule: state.peakRule,
    brows,
  };
}

function drawBrush(s) {
  const col = ui.tool === 'smudge' ? 'rgba(230,60,60,' : 'rgba(40,170,110,';
  if (ui.stroke) {
    const pts = ui.stroke.pts;
    ctx.strokeStyle = `${col}0.35)`;
    ctx.lineWidth = ui.stroke.r * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    ctx.stroke();
  }
  if (ui.hover) {
    ctx.strokeStyle = `${col}0.95)`;
    ctx.lineWidth = 1.5 / s;
    ctx.beginPath();
    ctx.arc(ui.hover[0], ui.hover[1], ui.brush / s, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  if (!photoOf() || state.view === 'compare') return;
  const { s, x, y } = ui.view;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
  const editing = net?.canEdit && ui.tool === 'move';
  drawScene(ctx, sceneFor(shown), { vs: s, overlays: true, handles: editing ? ui.side : null, eraseOn: state.erase.on });
  if (ui.tool === 'smudge' || ui.tool === 'restore') drawBrush(s);
}

function drawCursors() {
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.clearRect(0, 0, curCanvas.width, curCanvas.height);
  if (state.view === 'compare') return;
  const now = performance.now();
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.font = '600 12px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  for (const [id, c] of cursors) {
    if (now - c.at > 15000) {
      cursors.delete(id);
      continue;
    }
    const sx = c.x * ui.view.s + ui.view.x;
    const sy = c.y * ui.view.s + ui.view.y;
    cctx.fillStyle = c.color || '#333';
    cctx.beginPath();
    cctx.moveTo(sx, sy);
    cctx.lineTo(sx + 4, sy + 15);
    cctx.lineTo(sx + 8, sy + 10);
    cctx.lineTo(sx + 14, sy + 9);
    cctx.closePath();
    cctx.fill();
    const label = c.name || '成員';
    cctx.beginPath();
    cctx.roundRect(sx + 12, sy + 14, cctx.measureText(label).width + 10, 18, 9);
    cctx.fill();
    cctx.fillStyle = '#fff';
    cctx.fillText(label, sx + 17, sy + 27);
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(64, now - last);
  last = now;
  flush();
  const animating = stepAnim(dt);
  if (dirty || animating) {
    dirty = false;
    draw();
  }
  if (cursorsDirty) {
    cursorsDirty = false;
    drawCursors();
  }
  if (compareDirty && state.view === 'compare') {
    compareDirty = false;
    renderCompare();
  }
  requestAnimationFrame(frame);
}

// ---------- brow removal cache ----------

function eraseKey() {
  if (!photoOf() || !state.photo || !state.landmarks || !state.erase.on) return '';
  const lm = state.landmarks;
  return `${state.photo.id}|${lm[10]}|${lm[300]}|${JSON.stringify(state.erase)}`;
}

function checkErase() {
  const key = eraseKey();
  if (key === erased.key) return;
  erased.key = key;
  clearTimeout(erased.timer);
  if (!key) {
    erased.result = null;
    dirty = true;
    return;
  }
  erased.timer = setTimeout(() => {
    const f = F();
    const p = photoOf();
    if (erased.key !== key || !f || !p) return;
    const t0 = performance.now();
    const regions = ['L', 'R'].map((s) => ({ polygon: f[s].brow.polygon, thick: f[s].brow.thick }));
    const r = eraseBrows(p.imageData, regions, state.erase.strokes, state.erase);
    if (r) {
      const c = el('canvas', { width: r.w, height: r.h });
      c.getContext('2d').putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
      erased.result = { canvas: c, x: r.x, y: r.y };
    } else erased.result = null;
    console.debug(`[erase] ${Math.round(performance.now() - t0)} ms`);
    dirty = true;
    compareDirty = true;
  }, 30);
}

// ---------- photos ----------

async function addPhoto(meta, bytes) {
  const d = await decode(bytes);
  photos.set(meta.id, { meta, bytes, img: d.img, imageData: d.imageData });
  changed();
  return d;
}

async function landmarksOf(source, w, h) {
  busyOn('偵測臉部中');
  try {
    return await detectFace(source, w, h);
  } finally {
    busyOff();
  }
}

async function loadDemo() {
  const res = await fetch(DEMO.url);
  if (!res.ok) throw new Error(`demo image ${res.status}`);
  const d = await decode(await res.arrayBuffer());
  const meta = { id: DEMO.id, w: d.img.width, h: d.img.height };
  photos.set(DEMO.id, { meta, bytes: null, img: d.img, imageData: d.imageData });
  changed();
  let lm = null;
  try {
    lm = await landmarksOf(d.canvas, meta.w, meta.h);
  } catch (err) {
    console.warn('[demo] live face detection failed, trying saved landmarks', err);
  }
  if (!lm) {
    try {
      const r = await fetch(DEMO.landmarks);
      if (r.ok) lm = await r.json();
    } catch (err) {
      console.warn('[demo] no saved landmarks', err);
    }
  }
  if (!lm) toast('臉部偵測模型載入失敗（需要網路），定位線與新眉暫時無法使用');
  demoLandmarks = lm;
  return meta;
}

// The demo photo is the starting picture until someone uploads their own.
function useDemo(meta) {
  if (meta && net.role !== 'client' && !state.photo) net.op({ t: 'setPhoto', photo: meta, landmarks: demoLandmarks });
}

async function photoFromBlob(blob) {
  if (!net.canEdit) return toast(VIEW_ONLY);
  busyOn('處理照片中');
  try {
    const up = await prepareUpload(blob);
    const meta = { id: newId(), w: up.w, h: up.h };
    await addPhoto(meta, up.bytes);
    let lm = null;
    try {
      lm = await landmarksOf(up.canvas, up.w, up.h);
    } catch (err) {
      console.error('[face] detection failed', err);
      toast('臉部偵測模型載入失敗（需要網路）');
    }
    net.photo(meta, up.bytes);
    dispatch({ t: 'setPhoto', photo: meta, landmarks: lm });
    if (!lm) toast('未偵測到臉部，請換一張正面、露出眉毛的照片');
  } catch (err) {
    console.error('[photo] load failed', err);
    toast('照片無法開啟，請換一張 JPG 或 PNG');
  } finally {
    busyOff();
  }
}

$('btnUpload').addEventListener('click', () => $('fileInput').click());
for (const id of ['fileInput', 'captureInput']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) photoFromBlob(file);
  });
}
$('btnDemo').addEventListener('click', async () => {
  if (!net.canEdit) return toast(VIEW_ONLY);
  const d = photos.get(DEMO.id);
  if (!d) return toast('示範圖還在載入');
  if (!demoLandmarks) {
    try {
      const c = el('canvas', { width: d.meta.w, height: d.meta.h });
      c.getContext('2d').drawImage(d.img, 0, 0);
      demoLandmarks = await landmarksOf(c, d.meta.w, d.meta.h);
    } catch (err) {
      console.error('[demo] detection failed', err);
    }
  }
  dispatch({ t: 'setPhoto', photo: d.meta, landmarks: demoLandmarks });
});
initCamera(photoFromBlob);
for (const b of $$('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// ---------- compare view ----------

function planCanvas(plan, width) {
  const p = photoOf();
  if (!p) return null;
  const r = browRegion(F(), p.meta.w, p.meta.h);
  const k = width / r.w;
  const c = el('canvas', { width: Math.round(r.w * k), height: Math.round(r.h * k) });
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, -r.x * k, -r.y * k);
  drawScene(g, sceneFor(plan.brows), { vs: k, overlays: false, handles: null, eraseOn: state.erase.on });
  return c;
}

function renderCompare() {
  $('compare').replaceChildren(
    ...state.plans.map((plan) => {
      const preset = plan.brows ? PRESETS.find((x) => x.id === plan.brows.L.preset)?.name : '';
      const tile = el('div', { className: `tile${plan.id === state.active ? ' on' : ''}`, title: '點一下回到編輯這個方案' }, [
        planCanvas(plan, 640),
        el('div', { className: 'meta' }, [
          el('b', { textContent: plan.name }),
          el('span', { className: 'hint', textContent: preset ? `　${preset}` : '' }),
          el('p', { textContent: plan.note || '（尚未填寫設計理由）' }),
        ]),
      ]);
      tile.addEventListener('click', () => {
        dispatch({ t: 'selectPlan', plan: plan.id });
        dispatch({ t: 'setView', view: 'edit' });
      });
      return tile;
    }),
  );
}
// switching view changes everyone's screen, so it follows the edit lock
for (const b of $$('[data-view]')) b.addEventListener('click', () => dispatch({ t: 'setView', view: b.dataset.view }));

// ---------- teach ----------

$('btnTeach').addEventListener('click', () => dispatch({ t: 'setTeach', on: true, step: 0 }));
$('teachPrev').addEventListener('click', () => dispatch({ t: 'setTeach', step: state.teach.step - 1 }));
$('teachNext').addEventListener('click', () => {
  if (state.teach.step >= TEACH_STEPS.length - 1) dispatch({ t: 'setTeach', on: false });
  else dispatch({ t: 'setTeach', step: state.teach.step + 1 });
});
$('teachClose').addEventListener('click', () => dispatch({ t: 'setTeach', on: false }));

// ---------- undo ----------

$('btnUndo').addEventListener('click', () => net.canEdit && net.undo('undo'));
$('btnRedo').addEventListener('click', () => net.canEdit && net.undo('redo'));

// ---------- context for the UI modules ----------

const A = {
  me,
  room,
  ui,
  photos,
  get state() {
    return state;
  },
  get net() {
    return net;
  },
  F,
  activePlan,
  photoOf,
  dispatch,
  queue,
  flush,
  redraw,
  changed,
  setView,
  fit,
  zoomBrow,
  zoomAt,
  toImage,
  sceneFor,
  planCanvas,
  addPhoto,
  syncPanels: () => panels.syncPanels(),
};
const panels = initPanels(A);
initPointer(A, view);
initExport(A);
const records = initRecords(A);
const session = initSessionUI(A);

// ---------- sync DOM from state ----------

let syncQueued = false;
function changed() {
  redraw();
  compareDirty = true;
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    syncAll();
  });
}

function syncHistory() {
  const client = net?.role === 'client';
  $('btnUndo').disabled = !client && !history.canUndo;
  $('btnRedo').disabled = !client && !history.canRedo;
}

function syncTeach() {
  const t = state.teach;
  $('teachCard').hidden = !t.on;
  if (!t.on) return;
  const step = TEACH_STEPS[t.step];
  $('teachTitle').textContent = step.title;
  $('teachNum').textContent = `${t.step + 1} / ${TEACH_STEPS.length}`;
  $('teachText').textContent = step.text;
  $('teachPrev').disabled = t.step === 0;
  $('teachNext').textContent = t.step === TEACH_STEPS.length - 1 ? '完成' : '下一步';
}

function syncAll() {
  const p = photoOf();
  if (p && ui.fittedFor !== p.meta.id) {
    ui.fittedFor = p.meta.id;
    fit();
    snapShown();
  }
  panels.syncLeft();
  panels.syncPanels();

  $('compare').hidden = state.view !== 'compare';
  for (const b of $$('[data-view]')) b.classList.toggle('on', b.dataset.view === state.view);
  syncTeach();

  const readOnly = !!net && !net.canEdit;
  document.body.classList.toggle('locked', readOnly);
  $('lockBanner').hidden = !readOnly;
  session.syncControl();

  const waitingPhoto = !!state.photo && !photos.has(state.photo.id);
  if (!busy) {
    $('busy').hidden = !waitingPhoto;
    if (waitingPhoto) $('busyText').textContent = '接收照片中';
  }
  $('faceWarn').hidden = !(state.photo && !state.landmarks && !busy && demoDone);

  syncHistory();
  checkErase();
}

function busyOn(text) {
  busy = text;
  $('busyText').textContent = text;
  $('busy').hidden = false;
  $('faceWarn').hidden = true;
}
function busyOff() {
  busy = '';
  $('busy').hidden = true;
  changed();
}

// ---------- keyboard ----------

const TOOL_KEYS = { v: 'move', b: 'smudge', r: 'restore', h: 'pan' };
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (key === 'z' || key === 'y')) {
    e.preventDefault();
    if (net.canEdit) net.undo(key === 'y' || e.shiftKey ? 'redo' : 'undo');
  } else if (mod || e.altKey) {
    /* leave other browser shortcuts alone */
  } else if (TOOL_KEYS[key]) panels.setTool(TOOL_KEYS[key]);
  else if (key === '[') panels.setBrush(ui.brush - 3);
  else if (key === ']') panels.setBrush(ui.brush + 3);
  else if (key === ' ') {
    e.preventDefault();
    ui.space = true;
    view.style.cursor = 'grab';
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') ui.space = false;
});

// ---------- start ----------

const offlineTransport = { listen: async () => ({ ok: false, reason: 'error' }), dial: async () => null };

const netApp = {
  me,
  getState: () => state,
  setState(st, reason) {
    state = st;
    if (reason === 'local') snapShown();
    changed();
  },
  getPhoto() {
    const p = state.photo && photos.get(state.photo.id);
    return p?.bytes ? { meta: p.meta, bytes: p.bytes } : null; // demo: every peer loads it itself
  },
  onPhoto(meta, bytes) {
    addPhoto(meta, bytes).catch((err) => {
      console.error('[photo] decode failed', err);
      toast('收到的照片無法開啟');
    });
  },
  onMembers: session.renderMembers,
  onStatus: session.renderStatus,
  onNotice: toast,
  onCursor(c) {
    if (c.x == null) cursors.delete(c.id);
    else cursors.set(c.id, { ...c, at: performance.now() });
    cursorsDirty = true;
  },
  onLead: records.receiveLead,
  onHistory(h) {
    history = h;
    syncHistory();
  },
};

async function main() {
  resize();
  panels.setBrush(ui.brush);
  requestAnimationFrame(frame);
  let transport = offlineTransport;
  try {
    transport = (await import('./transport-peer.js')).peerTransport;
  } catch (err) {
    console.warn('[net] PeerJS unavailable, solo mode', err);
  }
  net = createNet({ transport, room, app: netApp });
  const demo = loadDemo()
    .catch((err) => {
      console.error('[demo] failed to load', err);
      toast('示範圖載入失敗，請直接上傳照片');
      return null;
    })
    .finally(() => {
      demoDone = true;
      changed();
    });
  const started = net.start();
  useDemo(await demo);
  await started;
  useDemo(await demo); // the host claim may finish after the demo
  changed();
}

main();

// debugging hook for the browser console and automated checks
window.browcanvas = { get state() { return state; }, get net() { return net; }, dispatch, ui, photos };
