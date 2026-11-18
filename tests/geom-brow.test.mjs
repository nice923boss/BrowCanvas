import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featuresFrom, anchorsFor } from '../js/face.js';
import { PRESETS, browFromPreset, toWorld, toLocal, outline, mirrorBrow, peakMetrics, withPeak, tailRise, withTailRise } from '../js/brow.js';
import { pointInPolygon, mirrorPoint, intersect } from '../js/geom.js';
import { syntheticLandmarks, nearP, near } from './fixture.mjs';

const f = featuresFrom(syntheticLandmarks());

test('featuresFrom reads both sides and rejects short input', () => {
  assert.equal(featuresFrom([]), null);
  assert.ok(f.hasIris);
  assert.ok(f.L.brow.head[0] > f.L.brow.tail[0], 'L head is towards the midline');
  assert.ok(f.R.brow.head[0] < f.R.brow.tail[0], 'R head is towards the midline');
  assert.ok(near(f.L.iris.r, 18, 1e-9));
  assert.ok(f.up[1] < 0, 'up points up in image coordinates');
});

test('anchorsFor puts head inside, tail outside, peak in range', () => {
  for (const s of ['L', 'R']) {
    const a = anchorsFor(f, s);
    assert.ok(a.peakX > 0.3 && a.peakX < 0.92);
    assert.ok(near(a.head[1], a.tail[1], 1e-6), 'tail on the horizontal through the head');
    const inward = s === 'L' ? 1 : -1;
    assert.ok((a.head[0] - a.tail[0]) * inward > 0);
  }
});

test('intersect returns null for parallel lines', () => {
  assert.equal(intersect([0, 0], [1, 0], [0, 1], [1, 0]), null);
});

test('toLocal inverts toWorld under scale, rotate and offset', () => {
  const a = anchorsFor(f, 'L');
  const b = { ...browFromPreset(PRESETS[0], a.head, a.tail), scale: 1.3, rotate: 17, dx: 12, dy: -7 };
  for (const p of [b.head, b.peak, b.tail, [10, 20]]) assert.ok(nearP(toLocal(b, toWorld(b, p)), p, 1e-9));
});

test('every preset gives a closed outline containing its spine', () => {
  const a = anchorsFor(f, 'L');
  for (const preset of PRESETS) {
    const b = browFromPreset(preset, a.head, a.tail);
    const o = outline(b, 24);
    assert.ok(o.polygon.length > 40, preset.id);
    assert.ok(o.polygon.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), preset.id);
    const midSpine = o.spine[Math.floor(o.spine.length / 3)];
    assert.ok(pointInPolygon(midSpine, o.polygon), `${preset.id}: spine inside outline`);
  }
});

test('mirrorBrow across the midline maps L anchors onto mirrored points', () => {
  const a = anchorsFor(f, 'L');
  const b = { ...browFromPreset(PRESETS[1], a.head, a.tail), rotate: 8, dx: 5, dy: 3 };
  const [m0, m1] = f.midline;
  const m = mirrorBrow(b, m0, m1);
  assert.ok(nearP(m.head, mirrorPoint(b.head, m0, m1), 1e-9));
  assert.equal(m.rotate, -8);
  // vertical midline: dx flips sign, dy stays
  assert.ok(near(m.dx, -5, 1e-9) && near(m.dy, 3, 1e-9));
  // the world-space outline is the mirror image too
  const w = toWorld(b, b.peak);
  assert.ok(nearP(toWorld(m, m.peak), mirrorPoint(w, m0, m1), 1e-6));
});

test('withPeak and withTailRise round-trip their metrics', () => {
  const a = anchorsFor(f, 'R');
  const b = browFromPreset(PRESETS[0], a.head, a.tail);
  const p = peakMetrics(withPeak(b, 0.6, 0.12));
  assert.ok(near(p.along, 0.6, 1e-9) && near(p.height, 0.12, 1e-9));
  assert.ok(near(tailRise(withTailRise(b, 9)), 9, 1e-9));
});
