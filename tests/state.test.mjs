import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, initialState, TEACH_STEPS, dragPointPatches } from '../js/state.js';
import { featuresFrom } from '../js/face.js';
import { toWorld } from '../js/brow.js';
import { syntheticLandmarks, near } from './fixture.mjs';

const withFace = () => applyOp(initialState(), { t: 'setPhoto', photo: { id: 'p1', w: 600, h: 800 }, landmarks: syntheticLandmarks() });

test('setPhoto anchors the plan brows and bumps rev', () => {
  const st = withFace();
  assert.equal(st.rev, 1);
  assert.ok(st.plans[0].brows.L && st.plans[0].brows.R);
  const noFace = applyOp(initialState(), { t: 'setPhoto', photo: { id: 'p2', w: 10, h: 10 }, landmarks: null });
  assert.equal(noFace.plans[0].brows, null);
});

test('unknown ops and no-ops return the same object', () => {
  const st = withFace();
  assert.equal(applyOp(st, { t: 'nope' }), st);
  assert.equal(applyOp(st, { t: 'undoStroke' }), st);
  assert.equal(applyOp(st, { t: 'selectPlan', plan: 'Z' }), st);
});

test('addPlan / removePlan guards', () => {
  let st = withFace();
  st = applyOp(st, { t: 'addPlan', id: 'B', name: '方案 B', copyFrom: 'A' });
  assert.equal(st.plans.length, 2);
  assert.equal(st.active, 'B');
  assert.deepEqual(st.plans[1].brows, st.plans[0].brows);
  assert.equal(applyOp(st, { t: 'addPlan', id: 'B', name: 'dup' }), st, 'existing id is a no-op');
  st = applyOp(st, { t: 'removePlan', plan: 'B' });
  assert.equal(st.active, 'A');
  assert.equal(applyOp(st, { t: 'removePlan', plan: 'A' }), st, 'last plan stays');
});

test('setBrows patches one side only', () => {
  const st = applyOp(withFace(), { t: 'setBrows', plan: 'A', patches: { L: { dy: -4 } } });
  assert.equal(st.plans[0].brows.L.dy, -4);
  assert.equal(st.plans[0].brows.R.dy, 0);
});

test('linked point drag moves the other side by the mirrored amount', () => {
  const st = withFace();
  const plan = st.plans[0];
  const f = featuresFrom(st.landmarks);
  const target = toWorld(plan.brows.L, [plan.brows.L.peak[0] + 6, plan.brows.L.peak[1] - 3]);
  const patches = dragPointPatches(plan, 'L', 'peak', target, f);
  const dL = [patches.L.peak[0] - plan.brows.L.peak[0], patches.L.peak[1] - plan.brows.L.peak[1]];
  const dR = [patches.R.peak[0] - plan.brows.R.peak[0], patches.R.peak[1] - plan.brows.R.peak[1]];
  assert.ok(near(dL[0], -dR[0], 1e-6) && near(dL[1], dR[1], 1e-6));
});

test('mirrorFrom keeps the target side dy', () => {
  let st = applyOp(withFace(), { t: 'setBrows', plan: 'A', patches: { R: { dy: 7 }, L: { rotate: 5 } } });
  st = applyOp(st, { t: 'mirrorFrom', plan: 'A', from: 'L' });
  assert.equal(st.plans[0].brows.R.dy, 7);
  assert.equal(st.plans[0].brows.R.rotate, -5);
});

test('erase strokes: add, undo, cleared by a new photo', () => {
  let st = withFace();
  st = applyOp(st, { t: 'addStroke', stroke: { mode: 'add', r: 5, pts: [[1, 1]] } });
  st = applyOp(st, { t: 'addStroke', stroke: { mode: 'remove', r: 5, pts: [[2, 2]] } });
  assert.equal(st.erase.strokes.length, 2);
  st = applyOp(st, { t: 'undoStroke' });
  assert.equal(st.erase.strokes.length, 1);
  st = applyOp(st, { t: 'setPhoto', photo: { id: 'p9', w: 600, h: 800 }, landmarks: syntheticLandmarks() });
  assert.equal(st.erase.strokes.length, 0);
});

test('replaceAll takes a project file, keeps rev, rejects files without plans', () => {
  const st = withFace();
  const file = { ...st, rev: 99, active: 'missing', layers: { oval: true } };
  const next = applyOp(st, { t: 'replaceAll', state: file });
  assert.equal(next.rev, st.rev + 1);
  assert.equal(next.active, 'A');
  assert.equal(next.layers.oval, true);
  assert.equal(next.layers.newBrow, true, 'missing layer keys get defaults');
  assert.equal(applyOp(st, { t: 'replaceAll', state: { plans: [] } }), st);
  assert.equal(applyOp(st, { t: 'replaceAll', state: null }), st);
});

test('setTeach clamps the step and applies its layers', () => {
  let st = applyOp(withFace(), { t: 'setTeach', on: true, step: 99 });
  assert.equal(st.teach.step, TEACH_STEPS.length - 1);
  st = applyOp(st, { t: 'setTeach', step: -3 });
  assert.equal(st.teach.step, 0);
  for (const [k, v] of Object.entries(TEACH_STEPS[0].layers)) assert.equal(st.layers[k], v, k);
  const off = applyOp(st, { t: 'setTeach', on: false });
  assert.equal(off.teach.on, false);
  assert.equal(off.layers, st.layers, 'turning off keeps the layers');
});

test('renamePlan and setNote cap their length', () => {
  let st = applyOp(withFace(), { t: 'renamePlan', plan: 'A', name: 'x'.repeat(50) });
  st = applyOp(st, { t: 'setNote', plan: 'A', note: 'y'.repeat(3000) });
  assert.equal(st.plans[0].name.length, 30);
  assert.equal(st.plans[0].note.length, 2000);
});

test('setControl moves control; replaceAll keeps control and lock', () => {
  const st = initialState();
  assert.equal(st.lock, true);
  assert.equal(st.control, null);
  const c = applyOp(st, { t: 'setControl', id: 'p1' });
  assert.equal(c.control, 'p1');
  assert.equal(c.rev, st.rev + 1);
  assert.equal(applyOp(c, { t: 'setControl', id: 'p1' }), c, 'same controller: no-op');
  assert.equal(applyOp(c, { t: 'setControl' }), c, 'missing id: no-op');
  const file = { ...initialState(), lock: false, control: 'x' };
  const r = applyOp(c, { t: 'replaceAll', state: file });
  assert.equal(r.control, 'p1');
  assert.equal(r.lock, true);
});
