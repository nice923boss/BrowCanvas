// Photo decoding, upload downscaling, camera capture and base64 for project files.

import { $, el, toast } from './dom.js';

const MAX_SIDE = 1600;

export async function decode(bytes, type = 'image/jpeg') {
  const img = await createImageBitmap(new Blob([bytes], { type }));
  const canvas = el('canvas', { width: img.width, height: img.height });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return { img, canvas, imageData: g.getImageData(0, 0, img.width, img.height) };
}

// Any picture the browser can open -> JPEG bytes no larger than MAX_SIDE.
export async function prepareUpload(blob) {
  const src = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
  const w = Math.round(src.width * k);
  const h = Math.round(src.height * k);
  const canvas = el('canvas', { width: w, height: h });
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  const jpeg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return { w, h, canvas, bytes: await jpeg.arrayBuffer() };
}

export function toBase64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

// Camera button: live preview dialog when allowed, otherwise the phone's
// camera app through the capture file input.
export function initCamera(onBlob) {
  let stream = null;
  $('btnCamera').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      $('captureInput').click();
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1600 } }, audio: false });
      $('camVideo').srcObject = stream;
      $('dlgCamera').showModal();
    } catch (err) {
      console.warn('[camera] getUserMedia failed', err);
      toast('無法開啟相機，改用選擇檔案');
      $('captureInput').click();
    }
  });
  $('dlgCamera').addEventListener('close', () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  });
  $('btnShoot').addEventListener('click', () => {
    const v = $('camVideo');
    if (!v.videoWidth) return;
    // the preview is mirrored by CSS; the saved photo is not
    const c = el('canvas', { width: v.videoWidth, height: v.videoHeight });
    c.getContext('2d').drawImage(v, 0, 0);
    $('dlgCamera').close();
    c.toBlob((blob) => blob && onBlob(blob), 'image/jpeg', 0.92);
  });
}
