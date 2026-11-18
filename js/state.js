// Shared session state and its pure reducer. Every peer runs the same
// applyOp() on the same ops, so the reducer must stay deterministic: no
// Date.now(), no Math.random(); ids come inside the op.
//
// The photo bytes are not in the state (they travel as a separate binary
// message); state.photo only names them. Customer contact data never enters
// the state.

import { featuresFrom, anchorsFor } from './face.js';
import { browFromPreset, presetById, applyPresetShape, mirrorBrow, toLocal } from './brow.js';
import { ERASE_DEFAULTS } from './erase.js';
import { mirrorVector, norm, sub, add } from './geom.js';

export const LAYER_DEFAULTS = {
  photo: true,
  photoOpacity: 1,
  sketch: false, // white paper background ("人偶草圖")
  oval: false,
  eyes: false,
  origBrow: false,
  ears: false,
  noseMouth: false,
  guides: true,
  thirds: false,
  newBrow: true,
  handles: true,
};

export const TEACH_STEPS = [
  { title: '確認臉部偵測', text: '檢查臉部輪廓、眼睛、原生眉位置是否對齊照片。', layers: { oval: true, eyes: true, origBrow: true, guides: false } },
  { title: '找眉頭', text: '鼻翼往內眼角延伸的線，與眉毛下緣相交處為常見的眉頭參考點。', layers: { guides: true, origBrow: true } },
  { title: '找眉峰', text: '鼻翼往虹膜外緣（或瞳孔、眼長 2/3）延伸的線，為常見的眉峰參考。', layers: { guides: true } },
  { title: '找眉尾', text: '鼻翼往外眼角延伸的線為眉尾參考；眉尾通常不低於眉頭的水平線。', layers: { guides: true } },
  { title: '去除原生眉', text: '自動遮罩原眉，用「抹除筆」補塗漏掉的毛，用「還原筆」修回誤抹的皮膚。', layers: { guides: false, origBrow: false } },
  { title: '套用眉型', text: '從眉型庫挑選，左右連動時一次套兩邊。', layers: { newBrow: true, handles: true } },
  { title: '左右微調', text: '左右眉可分別上下移動、縮放、旋轉，修正臉部不對稱。', layers: { handles: true } },
  { title: '比較方案、記錄理由', text: '建立 2 到 3 個方案並排比較，在備註寫下設計理由與顧客偏好。', layers: { handles: false } },
];

const SIDES = ['L', 'R'];

export function initialBrows(landmarks, presetId = 'natural', peakRule = 'irisOuter') {
  const f = featuresFrom(landmarks);
  if (!f) return null;
  const preset = presetById(presetId);
  const out = {};
  for (const s of SIDES) {
    const a = anchorsFor(f, s, peakRule);
    out[s] = browFromPreset(preset, a.head, a.tail, preset.peakX);
  }
  return out;
}

export function makePlan(id, name, brows = null) {
  return { id, name, brows, link: true, note: '' };
}

export function initialState() {
  return {
    v: 1,
    rev: 0,
    photo: null, // { id, w, h }
    landmarks: null, // [[x, y], ...] in image pixels, or null when no face found
    layers: { ...LAYER_DEFAULTS },
    peakRule: 'irisOuter',
    erase: { ...ERASE_DEFAULTS, on: true, strokes: [] },
    plans: [makePlan('A', '方案 A')],
    active: 'A',
    view: 'edit', // 'edit' | 'compare'
    lock: true, // true: only the controller edits; false: everyone edits
    control: null, // member id holding control; null or absent member: the network host
    teach: { on: false, step: 0 },
  };
}

const planIndex = (st, id) => st.plans.findIndex((p) => p.id === id);

function mapPlan(st, id, fn) {
  const i = planIndex(st, id);
  if (i < 0) return st;
  const plans = st.plans.slice();
  plans[i] = fn(plans[i]);
  return { ...st, plans };
}

function withBrowsFor(st, plan) {
  if (plan.brows || !st.landmarks) return plan;
  return { ...plan, brows: initialBrows(st.landmarks, 'natural', st.peakRule) };
}

export function applyOp(st, op) {
  const next = reduce(st, op);
  return next === st ? st : { ...next, rev: st.rev + 1 };
}

function reduce(st, op) {
  switch (op.t) {
    case 'setPhoto': {
      // New photo: new landmarks, erase strokes cleared, every plan re-anchored.
      const base = { ...st, photo: op.photo, landmarks: op.landmarks ?? null, erase: { ...st.erase, strokes: [] } };
      const plans = st.plans.map((p) => ({
        ...p,
        brows: base.landmarks ? reanchor(p.brows, base.landmarks, base.peakRule) : null,
      }));
      return { ...base, plans, view: 'edit' };
    }
    case 'setLandmarks': {
      const base = { ...st, landmarks: op.landmarks };
      return { ...base, plans: st.plans.map((p) => ({ ...p, brows: op.landmarks ? reanchor(p.brows, op.landmarks, st.peakRule) : null })) };
    }
    case 'setLayers':
      return { ...st, layers: { ...st.layers, ...op.patch } };
    case 'setPeakRule':
      return { ...st, peakRule: op.rule };
    case 'setErase':
      return { ...st, erase: { ...st.erase, ...op.patch } };
    case 'addStroke':
      return { ...st, erase: { ...st.erase, strokes: [...st.erase.strokes, op.stroke] } };
    case 'undoStroke':
      return st.erase.strokes.length ? { ...st, erase: { ...st.erase, strokes: st.erase.strokes.slice(0, -1) } } : st;
    case 'clearStrokes':
      return { ...st, erase: { ...st.erase, strokes: [] } };
    case 'setBrows':
      // patches: { L?: {...}, R?: {...} }, already resolved by the sender
      return mapPlan(st, op.plan, (p) => {
        const q = withBrowsFor(st, p);
        if (!q.brows) return q;
        const brows = { ...q.brows };
        for (const s of SIDES) if (op.patches[s]) brows[s] = { ...brows[s], ...op.patches[s] };
        return { ...q, brows };
      });
    case 'applyPreset':
      return mapPlan(st, op.plan, (p) => {
        const q = withBrowsFor(st, p);
        if (!q.brows) return q;
        const preset = presetById(op.preset);
        const brows = { ...q.brows };
        for (const s of op.sides) brows[s] = applyPresetShape(brows[s], preset);
        return { ...q, brows };
      });
    case 'resetBrows':
      // back to the guide anchors with the plan's current preset
      return mapPlan(st, op.plan, (p) => {
        if (!st.landmarks) return p;
        const fresh = initialBrows(st.landmarks, p.brows?.L?.preset ?? 'natural', st.peakRule);
        const brows = { ...(p.brows ?? fresh) };
        for (const s of op.sides) brows[s] = { ...fresh[s], color: brows[s]?.color ?? fresh[s].color };
        return { ...p, brows };
      });
    case 'mirrorFrom':
      // copy one side onto the other, mirrored across the face midline
      return mapPlan(st, op.plan, (p) => {
        const f = st.landmarks && featuresFrom(st.landmarks);
        if (!p.brows || !f) return p;
        const other = op.from === 'L' ? 'R' : 'L';
        const m = mirrorBrow(p.brows[op.from], f.midline[0], f.midline[1]);
        return { ...p, brows: { ...p.brows, [other]: { ...m, dy: p.brows[other].dy } } };
      });
    case 'setLink':
      return mapPlan(st, op.plan, (p) => ({ ...p, link: !!op.link }));
    case 'addPlan': {
      if (planIndex(st, op.id) >= 0) return st;
      const src = st.plans[planIndex(st, op.copyFrom)] ?? null;
      const plan = src
        ? { ...src, id: op.id, name: op.name, note: '' }
        : withBrowsFor(st, makePlan(op.id, op.name));
      return { ...st, plans: [...st.plans, plan], active: op.id };
    }
    case 'removePlan': {
      if (st.plans.length <= 1) return st;
      const plans = st.plans.filter((p) => p.id !== op.plan);
      if (plans.length === st.plans.length) return st;
      return { ...st, plans, active: st.active === op.plan ? plans[0].id : st.active };
    }
    case 'renamePlan':
      return mapPlan(st, op.plan, (p) => ({ ...p, name: String(op.name).slice(0, 30) }));
    case 'setNote':
      return mapPlan(st, op.plan, (p) => ({ ...p, note: String(op.note).slice(0, 2000) }));
    case 'selectPlan':
      return planIndex(st, op.plan) >= 0 ? { ...st, active: op.plan } : st;
    case 'setView':
      return { ...st, view: op.view === 'compare' ? 'compare' : 'edit' };
    case 'setLock':
      return { ...st, lock: !!op.lock };
    case 'setControl':
      return op.id && op.id !== st.control ? { ...st, control: String(op.id).slice(0, 40) } : st;
    case 'replaceAll': {
      // Opening a project file: take its content, keep defaults for anything missing.
      const base = initialState();
      const src = op.state ?? {};
      if (!Array.isArray(src.plans) || !src.plans.length) return st;
      return {
        ...base,
        ...src,
        rev: st.rev,
        lock: st.lock, // a project file must not change who controls the session
        control: st.control,
        layers: { ...base.layers, ...src.layers },
        erase: { ...base.erase, ...src.erase, strokes: Array.isArray(src.erase?.strokes) ? src.erase.strokes : [] },
        teach: { ...base.teach, ...src.teach },
        active: src.plans.some((p) => p.id === src.active) ? src.active : src.plans[0].id,
      };
    }
    case 'setTeach': {
      const step = Math.max(0, Math.min(TEACH_STEPS.length - 1, op.step ?? st.teach.step));
      const teach = { on: op.on ?? st.teach.on, step };
      const layers = teach.on && op.step !== undefined ? { ...st.layers, ...TEACH_STEPS[step].layers } : st.layers;
      return { ...st, teach, layers };
    }
    default:
      return st;
  }
}

// Keep a plan's shapes but move them onto a new face: fresh anchors with the
// plan's own presets and look.
function reanchor(brows, landmarks, peakRule) {
  const presetId = brows?.L?.preset ?? 'natural';
  const fresh = initialBrows(landmarks, presetId, peakRule);
  if (!fresh || !brows) return fresh;
  const out = {};
  for (const s of SIDES) {
    const b = brows[s];
    out[s] = { ...fresh[s], color: b.color, opacity: b.opacity, hair: b.hair, soft: b.soft, headFade: b.headFade };
  }
  return out;
}

// ---------- helpers the UI uses to build setBrows patches ----------

export const otherSide = (s) => (s === 'L' ? 'R' : 'L');

// Mirror a displacement across the face midline.
export function mirrorDelta(f, v) {
  return mirrorVector(v, norm(sub(f.midline[1], f.midline[0])));
}

// Patch for dragging a key point (head / peak / tail) of side s to world
// point `world`. When linked, the other side gets the mirrored displacement,
// so each side keeps its own anchors (faces are rarely symmetric).
export function dragPointPatches(plan, s, key, world, f) {
  const b = plan.brows[s];
  const local = toLocal(b, world);
  const patches = { [s]: { [key]: local } };
  if (plan.link && f) {
    const o = otherSide(s);
    const delta = mirrorDelta(f, sub(local, b[key]));
    patches[o] = { [key]: add(plan.brows[o][key], delta) };
  }
  return patches;
}
