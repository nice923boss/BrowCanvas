// Face features derived from MediaPipe Face Landmarker points (478 with irises),
// all in image pixels. "L" / "R" always mean the left / right side of the image
// (the customer's right / left).
//
// detectFace() loads MediaPipe from the CDN the first time it is called; the
// rest of this module is pure and runs in Node tests.

import { add, avg, dist, intersect, mid, mul, norm, sub, upNormal } from './geom.js';

export const IDX = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  eye: {
    L: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
    R: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
  },
  eyeInner: { L: 133, R: 362 },
  eyeOuter: { L: 33, R: 263 },
  iris: { L: [468, 469, 470, 471, 472], R: [473, 474, 475, 476, 477] },
  // Upper contour runs tail -> head, lower contour tail -> head.
  browUpper: { L: [70, 63, 105, 66, 107], R: [300, 293, 334, 296, 336] },
  browLower: { L: [46, 53, 52, 65, 55], R: [276, 283, 282, 295, 285] },
  noseWing: { L: 64, R: 294 },
  noseBridge: [168, 6, 197, 195, 5, 4, 1],
  noseBottom: 2,
  noseBase: [98, 97, 2, 326, 327],
  lipsOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146],
  lipsMid: [78, 13, 308, 14],
  cheek: { L: 234, R: 454 },
  top: 10,
  chin: 152,
  glabella: 9,
};

const P = (lm, i) => lm[i];
const pts = (lm, list) => list.map((i) => lm[i]);

export function featuresFrom(lm) {
  if (!Array.isArray(lm) || lm.length < 468) return null;
  const hasIris = lm.length >= 478;
  const side = (s) => {
    const inner = P(lm, IDX.eyeInner[s]);
    const outer = P(lm, IDX.eyeOuter[s]);
    const eyePts = pts(lm, IDX.eye[s]);
    let iris;
    if (hasIris) {
      const ring = pts(lm, IDX.iris[s].slice(1));
      const c = P(lm, IDX.iris[s][0]);
      iris = { c, r: ring.reduce((m, p) => m + dist(p, c), 0) / ring.length };
    } else {
      iris = { c: avg(eyePts), r: dist(inner, outer) * 0.2 };
    }
    const upper = pts(lm, IDX.browUpper[s]);
    const lower = pts(lm, IDX.browLower[s]);
    const centre = upper.map((p, i) => mid(p, lower[i])); // tail -> head
    return {
      eye: eyePts,
      inner,
      outer,
      iris,
      brow: {
        upper,
        lower,
        polygon: [...upper, ...[...lower].reverse()],
        head: centre[centre.length - 1],
        peak: centre[2],
        tail: centre[0],
        thick: upper.reduce((m, p, i) => m + dist(p, lower[i]), 0) / upper.length,
      },
      wing: P(lm, IDX.noseWing[s]),
      cheek: P(lm, IDX.cheek[s]),
    };
  };
  const L = side('L');
  const R = side('R');
  const oval = pts(lm, IDX.oval);
  const top = P(lm, IDX.top);
  const chin = P(lm, IDX.chin);
  const faceW = dist(L.cheek, R.cheek);
  // Face "horizontal": the line through both inner eye corners.
  const hor = norm(sub(R.inner, L.inner));
  const up = upNormal(hor);
  const noseBottom = P(lm, IDX.noseBottom);
  const browY = mid(L.brow.head, R.brow.head);

  // Ears are not part of the face mesh: estimated beside the cheek points,
  // from brow level down to the bottom of the nose (a common proportion).
  const ear = (s) => {
    const f = s === 'L' ? L : R;
    const outward = s === 'L' ? mul(hor, -1) : hor;
    const topY = intersect(f.cheek, up, browY, hor) ?? f.cheek;
    const botY = intersect(f.cheek, up, noseBottom, hor) ?? f.cheek;
    const centre = add(mid(topY, botY), mul(outward, faceW * 0.045));
    return { centre, rx: faceW * 0.06, ry: dist(topY, botY) / 2, outward, estimated: true };
  };

  // Hairline is not in the mesh either: estimated one "third" above the brows.
  const midThird = dist(browY, noseBottom);
  const hairline = add(browY, mul(up, midThird));

  return {
    hasIris,
    oval,
    L,
    R,
    top,
    chin,
    hor,
    up,
    faceW,
    noseBridge: pts(lm, IDX.noseBridge),
    noseBase: pts(lm, IDX.noseBase),
    noseBottom,
    lips: pts(lm, IDX.lipsOuter),
    lipsMid: pts(lm, IDX.lipsMid),
    midline: [P(lm, IDX.glabella), chin],
    ears: { L: ear('L'), R: ear('R') },
    thirds: { hairline, brow: browY, nose: noseBottom, chin },
  };
}

// Common brow positioning guides, from the nose wing through:
//   head: the inner eye corner; peak: per `peakRule`; tail: the outer eye corner.
// These are reference lines only; the teacher decides the actual rules.
export const PEAK_RULES = {
  irisOuter: '虹膜外緣',
  iris: '瞳孔中心',
  eye23: '眼長 2/3 處',
};

export function guidesFor(f, s, peakRule = 'irisOuter') {
  const e = f[s];
  const outward = s === 'L' ? mul(f.hor, -1) : f.hor;
  let peakRef;
  if (peakRule === 'iris') peakRef = e.iris.c;
  else if (peakRule === 'eye23') peakRef = add(e.inner, mul(sub(e.outer, e.inner), 2 / 3));
  else peakRef = add(e.iris.c, mul(outward, e.iris.r));
  const line = (through) => ({ from: e.wing, dir: norm(sub(through, e.wing)), through });
  return { head: line(e.inner), peak: line(peakRef), tail: line(e.outer) };
}

// Where the guides cross the original brow: head on the brow base line, tail
// on the face-horizontal line through the head (same height as the head), and
// the peak's position along the head -> tail line.
export function anchorsFor(f, s, peakRule = 'irisOuter') {
  const g = guidesFor(f, s, peakRule);
  const b = f[s].brow;
  const baseDir = norm(sub(b.tail, b.head));
  const head = intersect(g.head.from, g.head.dir, b.head, baseDir) ?? b.head;
  const tail = intersect(g.tail.from, g.tail.dir, head, f.hor) ?? b.tail;
  const peakOnLine = intersect(g.peak.from, g.peak.dir, head, sub(tail, head));
  const ht = sub(tail, head);
  const L = Math.hypot(ht[0], ht[1]);
  let peakX = 0.65;
  if (peakOnLine && L > 0) {
    const t = ((peakOnLine[0] - head[0]) * ht[0] + (peakOnLine[1] - head[1]) * ht[1]) / (L * L);
    if (t > 0.3 && t < 0.92) peakX = t;
  }
  return { head, tail, peakX, origThick: b.thick };
}

// ---------- MediaPipe (browser only) ----------

const MP_VER = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let landmarkerPromise = null;

async function landmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'IMAGE',
          numFaces: 1,
        });
      try {
        return await make('GPU');
      } catch (err) {
        console.warn('[face] GPU delegate failed, using CPU', err);
        return make('CPU');
      }
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null; // allow a retry later
    });
  }
  return landmarkerPromise;
}

// Returns landmarks in image pixels (rounded to 0.1 px) or null when no face.
export async function detectFace(source, w, h) {
  const fl = await landmarker();
  const res = fl.detect(source);
  const face = res.faceLandmarks?.[0];
  if (!face) return null;
  return face.map((p) => [Math.round(p.x * w * 10) / 10, Math.round(p.y * h * 10) / 10]);
}
