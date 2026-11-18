// Fine-adjust sliders of the selected brow. Each definition maps a brow to a
// slider value (get) and a value back to a setBrows patch (set).
// link: 'copy' same value on both sides, 'neg' mirrored change, 'own' this side only.

import { peakMetrics, withPeak, tailRise, withTailRise } from './brow.js';
import { otherSide } from './state.js';
import { clamp } from './geom.js';

const IRIS_MM = 11.7; // average visible iris diameter, used for rough mm readouts

export function createSliders(getF) {
  const faceW = () => getF()?.faceW ?? 300;
  const upVec = () => getF()?.up ?? [0, -1];
  const blen = (b) => peakMetrics(b).length;
  // Rough millimetres from the iris; px when the iris is unknown.
  const fmtLen = (px) => {
    const f = getF();
    const k = f?.hasIris ? IRIS_MM / (f.L.iris.r + f.R.iris.r) : null;
    return k ? `約 ${(px * k).toFixed(1)} mm` : `${Math.round(px)} px`;
  };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const num = (v) => `${Math.round(v * 100)}`;
  const thick = (key, label, min, max, step) => ({
    key, label, min, max, step, link: 'copy',
    get: (b) => b[key] / blen(b),
    set: (b, v) => ({ [key]: v * blen(b) }),
    fmt: (v, b) => fmtLen(v * blen(b) * b.scale),
  });
  const plain = (key, label, min, max, fmt, fallback) => ({
    key, label, min, max, step: 0.01, link: 'copy',
    get: (b) => b[key] ?? fallback,
    set: (b, v) => ({ [key]: v }),
    fmt,
  });

  const SLIDERS = [
    { group: '位置與大小' },
    { key: 'dy', label: '上下位置', min: -0.1, max: 0.1, step: 0.001, link: 'own', get: (b) => -b.dy / faceW(), set: (b, v) => ({ dy: -v * faceW() }), fmt: (v) => `${v >= 0 ? '上' : '下'} ${fmtLen(Math.abs(v) * faceW())}` },
    { key: 'dx', label: '左右位置', min: -0.1, max: 0.1, step: 0.001, link: 'neg', get: (b) => b.dx / faceW(), set: (b, v) => ({ dx: v * faceW() }), fmt: (v) => `${v >= 0 ? '右' : '左'} ${fmtLen(Math.abs(v) * faceW())}` },
    { key: 'scale', label: '整體大小', min: 0.6, max: 1.6, step: 0.01, link: 'copy', get: (b) => b.scale, set: (b, v) => ({ scale: v }), fmt: pct },
    { key: 'rotate', label: '旋轉角度', min: -25, max: 25, step: 0.5, link: 'neg', get: (b) => b.rotate, set: (b, v) => ({ rotate: v }), fmt: (v) => `${v.toFixed(1)}°` },
    { group: '眉頭、眉峰、眉尾' },
    { key: 'peakAlong', label: '眉峰前後位置', min: 0.35, max: 0.9, step: 0.005, link: 'copy', get: (b) => peakMetrics(b).along, set: (b, v) => ({ peak: withPeak(b, v, peakMetrics(b).height).peak }), fmt: (v) => `眉長 ${pct(v)}` },
    { key: 'peakHeight', label: '眉峰高度（弧度）', min: -0.02, max: 0.3, step: 0.002, link: 'copy', get: (b) => peakMetrics(b).height, set: (b, v) => ({ peak: withPeak(b, peakMetrics(b).along, v).peak }), fmt: (v, b) => fmtLen(v * blen(b)) },
    {
      key: 'tailRise', label: '眉尾高低', min: -0.15, max: 0.2, step: 0.002, link: 'copy',
      get: (b) => tailRise(b, upVec()) / blen(b),
      set: (b, v) => {
        const n = withTailRise(b, v * blen(b), upVec());
        return { tail: n.tail, peak: n.peak };
      },
      fmt: (v, b) => `${v >= 0 ? '高於' : '低於'}眉頭 ${fmtLen(Math.abs(v) * blen(b))}`,
    },
    plain('arch', '眉峰轉折（圓↔尖）', 0, 1, num, 0.5),
    { group: '粗細' },
    thick('tH', '眉頭粗細', 0.04, 0.32, 0.002),
    thick('tP', '眉峰粗細', 0.03, 0.28, 0.002),
    thick('tT', '眉尾粗細', 0.005, 0.15, 0.001),
    plain('upper', '往上長↔往下長', 0.1, 0.9, (v) => `上 ${pct(v)}`, 0.5),
    { group: '質感' },
    plain('hair', '毛流密度', 0, 1, num, 0.5),
    plain('opacity', '顏色濃淡', 0.15, 1, pct, 0.85),
    plain('soft', '邊緣柔和', 0, 1, num, 0.5),
    plain('headFade', '眉頭漸層', 0, 1, num, 0.5),
  ];

  function sliderPatches(plan, side, def, v) {
    const b = plan.brows[side];
    const patches = { [side]: def.set(b, v) };
    if (plan.link && def.link !== 'own') {
      const o = otherSide(side);
      const ob = plan.brows[o];
      const ov = def.link === 'neg' ? def.get(ob) - (v - def.get(b)) : v;
      patches[o] = def.set(ob, clamp(ov, def.min, def.max));
    }
    return patches;
  }

  return { SLIDERS, sliderPatches };
}
