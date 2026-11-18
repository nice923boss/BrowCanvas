import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dilate, pushPull, eraseBrows } from '../js/erase.js';

const SKIN = [205, 165, 145];
const BROW = [70, 50, 40];

// 160 x 100 skin image with a dark band (the "brow") at x 40..120, y 40..52.
function browImage() {
  const width = 160;
  const height = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBrow = x >= 40 && x < 120 && y >= 40 && y < 52;
      const c = inBrow ? BROW : SKIN;
      const noise = ((x * 7 + y * 13) % 5) - 2; // mild deterministic texture
      const i = (y * width + x) * 4;
      data[i] = c[0] + noise;
      data[i + 1] = c[1] + noise;
      data[i + 2] = c[2] + noise;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const browPolygon = [[40, 40], [120, 40], [120, 52], [40, 52]];

test('dilate grows a single pixel into a square', () => {
  const w = 7;
  const src = new Uint8Array(w * w);
  src[3 * w + 3] = 1;
  const out = dilate(src, w, w, 2);
  let count = 0;
  for (let i = 0; i < out.length; i++) count += out[i] ? 1 : 0;
  assert.equal(count, 25);
  assert.equal(out[0], 0);
  assert.deepEqual(dilate(src, w, w, 0), src);
});

test('pushPull fills unknown pixels from known ones, keeps known pixels', () => {
  const w = 9;
  const h = 5;
  const rgb = new Float32Array(w * h * 3);
  const known = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < 3) {
        rgb.set([200, 100, 50], i * 3);
        known[i] = 1;
      } else if (x > 5) {
        rgb.set([100, 100, 100], i * 3);
        known[i] = 1;
      }
    }
  }
  const out = pushPull(rgb, known, w, h);
  assert.equal(out[0], 200);
  assert.equal(out[(w - 1) * 3], 100);
  for (let y = 0; y < h; y++) {
    for (let x = 3; x <= 5; x++) {
      const r = out[(y * w + x) * 3];
      assert.ok(r >= 100 && r <= 200, `filled red between neighbours at ${x},${y}: ${r}`);
    }
  }
});

test('eraseBrows returns null when there is nothing to erase', () => {
  const img = browImage();
  assert.equal(eraseBrows(img, [], []), null);
  assert.equal(eraseBrows(img, [{ polygon: browPolygon, thick: 12 }], [], { auto: false }), null);
});

test('eraseBrows replaces the dark band with skin-like colour', () => {
  const img = browImage();
  const res = eraseBrows(img, [{ polygon: browPolygon, thick: 12 }], []);
  assert.ok(res);
  let sum = 0;
  let n = 0;
  for (let y = 42; y < 50; y++) {
    for (let x = 50; x < 110; x++) {
      const i = ((y - res.y) * res.w + (x - res.x)) * 4;
      sum += res.data[i];
      n++;
    }
  }
  const meanRed = sum / n;
  assert.ok(Math.abs(meanRed - SKIN[0]) < 15, `mean red in old brow area ${meanRed.toFixed(1)}`);
  // pixels well away from the brow are untouched
  const fx = res.x + 2;
  const fy = res.y + 2;
  const j = ((fy - res.y) * res.w + (fx - res.x)) * 4;
  assert.equal(res.data[j], img.data[(fy * img.width + fx) * 4]);
});

test('a remove stroke keeps pixels that the auto mask would erase', () => {
  const img = browImage();
  const keep = { mode: 'remove', r: 6, pts: [[60, 46], [70, 46]] };
  const res = eraseBrows(img, [{ polygon: browPolygon, thick: 12 }], [keep]);
  const i = ((46 - res.y) * res.w + (65 - res.x)) * 4;
  assert.equal(res.data[i], img.data[(46 * img.width + 65) * 4], 'pixel under the restore stroke is original');
});

test('an add stroke alone erases without detected regions', () => {
  const img = browImage();
  const res = eraseBrows(img, [], [{ mode: 'add', r: 5, pts: [[80, 46], [90, 46]] }], { auto: false });
  assert.ok(res);
  const i = ((46 - res.y) * res.w + (85 - res.x)) * 4;
  assert.ok(res.data[i] > 120, `stroke area lightened: ${res.data[i]}`);
});
