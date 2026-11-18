// Synthetic 478-point face in a 600 x 800 image: only the landmarks that
// face.js reads get real positions, the rest sit at the face centre.

import { IDX } from '../js/face.js';

const W = 600;
const MID = W / 2;
const flipX = ([x, y]) => [W - x, y];

export function syntheticLandmarks() {
  const lm = Array.from({ length: 478 }, () => [MID, 450]);
  const set = (i, p) => {
    lm[i] = p;
  };

  // oval: ellipse around the face
  IDX.oval.forEach((i, k) => {
    const a = (k / IDX.oval.length) * 2 * Math.PI - Math.PI / 2;
    set(i, [MID + 170 * Math.cos(a), 435 + 285 * Math.sin(a)]);
  });

  // eyes (L centre 220, R centre 380), corners, irises
  for (const s of ['L', 'R']) {
    const cx = s === 'L' ? 220 : 380;
    IDX.eye[s].forEach((i, k) => {
      const a = (k / IDX.eye[s].length) * 2 * Math.PI;
      set(i, [cx + 45 * Math.cos(a), 380 + 14 * Math.sin(a)]);
    });
    const [c, ...ring] = IDX.iris[s];
    set(c, [cx, 380]);
    ring.forEach((i, k) => {
      const a = (k / ring.length) * 2 * Math.PI;
      set(i, [cx + 18 * Math.cos(a), 380 + 18 * Math.sin(a)]);
    });
  }
  set(IDX.eyeOuter.L, [175, 380]);
  set(IDX.eyeInner.L, [265, 380]);
  set(IDX.eyeInner.R, [335, 380]);
  set(IDX.eyeOuter.R, [425, 380]);

  // brows, tail -> head
  const upperL = [[165, 320], [185, 308], [210, 302], [235, 305], [262, 312]];
  const lowerL = [[168, 334], [188, 324], [212, 318], [237, 320], [262, 326]];
  IDX.browUpper.L.forEach((i, k) => set(i, upperL[k]));
  IDX.browLower.L.forEach((i, k) => set(i, lowerL[k]));
  IDX.browUpper.R.forEach((i, k) => set(i, flipX(upperL[k])));
  IDX.browLower.R.forEach((i, k) => set(i, flipX(lowerL[k])));

  set(IDX.noseWing.L, [270, 500]);
  set(IDX.noseWing.R, [330, 500]);
  set(IDX.cheek.L, [130, 420]);
  set(IDX.cheek.R, [470, 420]);
  set(IDX.top, [MID, 150]);
  set(IDX.chin, [MID, 720]);
  set(IDX.glabella, [MID, 330]);
  set(IDX.noseBottom, [MID, 520]);
  return lm;
}

export const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
export const nearP = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
