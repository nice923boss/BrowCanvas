// Left and right panels: tools, brow removal, layers, plans, presets, sliders
// and colours. Changes go out as ops; syncPanels() mirrors the shared state
// back into the controls. `A` is the app context.

import { $, $$, el, toast } from './dom.js';
import { PEAK_RULES } from './face.js';
import { PRESETS, COLORS, presetPath } from './brow.js';
import { otherSide } from './state.js';
import { createSliders } from './sliders.js';
import { clamp } from './geom.js';
import * as store from './store.js';

const SIDE_NAME = { L: '畫面左眉', R: '畫面右眉' };
const ERASE_SLIDERS = [
  ['eraseExpand', 'expand', (v) => v.toFixed(2)],
  ['eraseSens', 'sens', (v) => String(v)],
  ['eraseTex', 'texture', (v) => v.toFixed(2)],
];

const focused = (n) => document.activeElement === n;
const setVal = (n, v) => {
  if (!focused(n) && String(n.value) !== String(v)) n.value = v;
};
const setChk = (n, v) => {
  if (n.checked !== !!v) n.checked = !!v;
};

export function initPanels(A) {
  const { ui } = A;

  // ----- tools -----
  function setTool(t) {
    ui.tool = t;
    for (const b of $$('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
    A.redraw();
  }
  for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

  function setBrush(v) {
    ui.brush = clamp(Math.round(v), 3, 60);
    $('brushSize').value = ui.brush;
    $('brushVal').textContent = ui.brush;
    A.redraw();
  }
  $('brushSize').addEventListener('input', (e) => setBrush(+e.target.value));
  $('btnFit').addEventListener('click', A.fit);
  $('btnZoomBrow').addEventListener('click', A.zoomBrow);

  // ----- brow removal -----
  $('eraseOn').addEventListener('change', (e) => A.dispatch({ t: 'setErase', patch: { on: e.target.checked } }));
  $('eraseAuto').addEventListener('change', (e) => A.dispatch({ t: 'setErase', patch: { auto: e.target.checked } }));
  for (const [id, key, fmt] of ERASE_SLIDERS) {
    $(id).addEventListener('input', (e) => {
      $(`${id}Val`).textContent = fmt(+e.target.value);
      A.queue({ t: 'setErase', patch: { [key]: +e.target.value }, k: `erase:${key}` });
    });
  }
  $('btnUndoStroke').addEventListener('click', () => A.dispatch({ t: 'undoStroke' }));
  $('btnClearStrokes').addEventListener('click', () => A.dispatch({ t: 'clearStrokes' }));

  // ----- layers -----
  for (const c of $$('[data-layer]')) c.addEventListener('change', () => A.dispatch({ t: 'setLayers', patch: { [c.dataset.layer]: c.checked } }));
  $('photoOpacity').addEventListener('input', (e) => {
    $('photoOpVal').textContent = `${Math.round(e.target.value * 100)}%`;
    A.queue({ t: 'setLayers', patch: { photoOpacity: +e.target.value }, k: 'layer:photoOpacity' });
  });
  for (const [id, name] of Object.entries(PEAK_RULES)) $('peakRule').append(el('option', { value: id, textContent: name }));
  $('peakRule').addEventListener('change', (e) => {
    if (A.dispatch({ t: 'setPeakRule', rule: e.target.value })) toast('定位線已更新；按「重設到定位線」可把眉型移到新位置');
  });

  // ----- plans -----
  function nextPlanId() {
    const used = new Set(A.state.plans.map((p) => p.id));
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(ch)) return ch;
    return store.newId();
  }
  function renderPlanTabs() {
    const st = A.state;
    $('planTabs').replaceChildren(
      ...st.plans.map((p) =>
        el('button', { className: `plan-tab${p.id === st.active ? ' on' : ''}`, textContent: p.name, onclick: () => A.dispatch({ t: 'selectPlan', plan: p.id }) }),
      ),
      el('button', {
        className: 'plan-tab add',
        textContent: '＋ 新方案',
        title: '用自然標準眉建立新方案',
        onclick: () => {
          const id = nextPlanId();
          A.dispatch({ t: 'addPlan', id, name: `方案 ${id.length === 1 ? id : A.state.plans.length + 1}` });
        },
      }),
    );
  }
  $('btnPlanDup').addEventListener('click', () => {
    const src = A.activePlan();
    A.dispatch({ t: 'addPlan', id: nextPlanId(), name: `${src.name} 複本`.slice(0, 30), copyFrom: src.id });
  });
  $('btnPlanDel').addEventListener('click', () => {
    if (A.state.plans.length <= 1) return toast('至少要保留一個方案');
    const p = A.activePlan();
    if (confirm(`刪除「${p.name}」？`)) A.dispatch({ t: 'removePlan', plan: p.id });
  });
  $('planName').addEventListener('input', (e) => A.queue({ t: 'renamePlan', plan: A.state.active, name: e.target.value, k: `name:${A.state.active}` }));
  $('planNote').addEventListener('input', (e) => A.queue({ t: 'setNote', plan: A.state.active, note: e.target.value, k: `note:${A.state.active}` }));

  // ----- presets -----
  for (const preset of PRESETS) {
    const b = el('button', { className: 'preset', title: `套用${preset.name}` });
    b.dataset.preset = preset.id;
    b.innerHTML = `<svg viewBox="0 0 96 40" aria-hidden="true"><path d="${presetPath(preset)}" fill="${preset.color}"/></svg>`;
    b.append(el('span', { textContent: preset.name }));
    b.addEventListener('click', () => {
      const plan = A.activePlan();
      if (!plan?.brows) return toast('需要先偵測到臉部');
      A.dispatch({ t: 'applyPreset', plan: plan.id, preset: preset.id, sides: plan.link ? ['L', 'R'] : [ui.side] });
    });
    $('presets').append(b);
  }

  // ----- side, link, mirror, reset, hide -----
  for (const b of $$('[data-side]')) b.addEventListener('click', () => {
    ui.side = b.dataset.side;
    syncPanels();
    A.redraw();
  });
  $('linkSides').addEventListener('change', (e) => A.dispatch({ t: 'setLink', plan: A.state.active, link: e.target.checked }));
  $('btnMirror').addEventListener('click', () => {
    if (A.dispatch({ t: 'mirrorFrom', plan: A.state.active, from: ui.side })) toast(`已把${SIDE_NAME[ui.side]}鏡像到另一邊（上下位置保留）`);
  });
  $('btnReset').addEventListener('click', () => {
    const plan = A.activePlan();
    A.dispatch({ t: 'resetBrows', plan: plan.id, sides: plan.link ? ['L', 'R'] : [ui.side] });
  });
  $('btnHideSide').addEventListener('click', () => {
    const plan = A.activePlan();
    const b = plan?.brows?.[ui.side];
    if (b) A.dispatch({ t: 'setBrows', plan: plan.id, patches: { [ui.side]: { visible: b.visible === false } } });
  });

  // ----- sliders -----
  const { SLIDERS, sliderPatches } = createSliders(A.F);
  const sliderRefs = [];
  for (const def of SLIDERS) {
    if (def.group) {
      $('sliders').append(el('div', { className: 'colors-head', textContent: def.group }));
      continue;
    }
    const val = el('b');
    const input = el('input', { type: 'range', min: def.min, max: def.max, step: def.step });
    input.addEventListener('input', () => {
      const plan = A.activePlan();
      if (!plan?.brows) return;
      const v = +input.value;
      val.textContent = def.fmt(v, plan.brows[ui.side]);
      A.queue({ t: 'setBrows', plan: plan.id, patches: sliderPatches(plan, ui.side, def, v), k: `slider:${plan.id}:${def.key}` });
    });
    sliderRefs.push({ def, input, val });
    $('sliders').append(el('label', { className: 'slider' }, [el('span', {}, [`${def.label} `, val]), input]));
  }

  // ----- colours -----
  function setColor(value, live) {
    const plan = A.activePlan();
    if (!plan?.brows) return;
    const patches = { [ui.side]: { color: value } };
    if (plan.link) patches[otherSide(ui.side)] = { color: value };
    const op = { t: 'setBrows', plan: plan.id, patches, k: `color:${plan.id}` };
    if (live) A.queue(op);
    else A.dispatch(op);
  }
  for (const c of COLORS) {
    const b = el('button', { className: 'swatch', title: c.name });
    b.style.setProperty('--c', c.value);
    b.dataset.color = c.value;
    b.addEventListener('click', () => setColor(c.value, false));
    $('colors').append(b);
  }
  const customColor = el('input', { type: 'color', title: '自訂眉色', value: '#5a4636' });
  customColor.addEventListener('input', () => setColor(customColor.value, true));
  $('colors').append(customColor);

  // ----- state -> controls -----
  function syncPanels() {
    const plan = A.activePlan();
    const b = plan?.brows?.[ui.side];
    renderPlanTabs();
    setVal($('planName'), plan?.name ?? '');
    setVal($('planNote'), plan?.note ?? '');
    setChk($('linkSides'), plan?.link);
    for (const x of $$('[data-side]')) x.classList.toggle('on', x.dataset.side === ui.side);
    for (const x of $$('[data-preset]')) x.classList.toggle('on', !!b && b.preset === x.dataset.preset);
    for (const x of $$('[data-color]')) x.classList.toggle('on', !!b && b.color === x.dataset.color);
    $('btnHideSide').textContent = b?.visible === false ? '顯示這邊' : '隱藏這邊';
    for (const r of sliderRefs) {
      r.input.disabled = !b;
      if (!b) {
        r.val.textContent = '';
        continue;
      }
      const v = r.def.get(b);
      setVal(r.input, v);
      r.val.textContent = r.def.fmt(clamp(v, r.def.min, r.def.max), b);
    }
  }

  function syncLeft() {
    const st = A.state;
    for (const c of $$('[data-layer]')) setChk(c, st.layers[c.dataset.layer]);
    setVal($('photoOpacity'), st.layers.photoOpacity);
    $('photoOpVal').textContent = `${Math.round(st.layers.photoOpacity * 100)}%`;
    setVal($('peakRule'), st.peakRule);
    setChk($('eraseOn'), st.erase.on);
    setChk($('eraseAuto'), st.erase.auto);
    for (const [id, key, fmt] of ERASE_SLIDERS) {
      setVal($(id), st.erase[key]);
      $(`${id}Val`).textContent = fmt(+st.erase[key]);
    }
    $('btnUndoStroke').disabled = !st.erase.strokes.length;
    $('btnClearStrokes').disabled = !st.erase.strokes.length;
  }

  // ----- mobile bottom sheets -----
  for (const b of $$('[data-panel]')) {
    b.addEventListener('click', () => {
      const panel = $(b.dataset.panel);
      const open = !panel.classList.contains('open');
      for (const p of $$('.panel')) p.classList.remove('open');
      for (const x of $$('[data-panel]')) x.classList.remove('on');
      panel.classList.toggle('open', open);
      b.classList.toggle('on', open);
    });
  }

  return { setTool, setBrush, syncPanels, syncLeft };
}
