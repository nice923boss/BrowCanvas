// Export menu: full-size PNG (with or without guides), plan comparison sheet,
// and the project file (state + photo) that can be opened again.
// `A` is the app context built in app.js.

import { $, $$, el, toast, VIEW_ONLY, stamp, download, canvasBlob, safeName } from './dom.js';
import { drawScene } from './render.js';
import { toBase64, fromBase64 } from './photo-io.js';

const FONT = '"Noto Sans TC", "Microsoft JhengHei", sans-serif';

function wrapText(g, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (g.measureText(line + ch).width > maxW && line) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

export function initExport(A) {
  async function exportFull(guides) {
    const p = A.photoOf();
    if (!p) return;
    const plan = A.activePlan();
    const c = el('canvas', { width: p.meta.w, height: p.meta.h });
    const vs = Math.min(1, 900 / Math.max(p.meta.w, p.meta.h));
    drawScene(c.getContext('2d'), A.sceneFor(plan.brows), { vs, overlays: guides, handles: null, eraseOn: A.state.erase.on });
    download(await canvasBlob(c), `BrowCanvas-${safeName(plan.name)}-${stamp()}.png`);
  }

  async function exportCompare() {
    const tiles = A.state.plans.map((p) => ({ plan: p, c: A.planCanvas(p, 720) })).filter((t) => t.c);
    if (!tiles.length) return;
    const cols = Math.min(3, tiles.length);
    const tw = 720;
    const th = tiles[0].c.height;
    const meas = el('canvas').getContext('2d');
    meas.font = `22px ${FONT}`;
    const notes = tiles.map((t) => wrapText(meas, t.plan.note || '', tw - 40).slice(0, 6));
    const textH = 56 + Math.max(...notes.map((n) => n.length)) * 32;
    const rows = Math.ceil(tiles.length / cols);
    const pad = 24;
    const c = el('canvas', { width: cols * tw + (cols + 1) * pad, height: rows * (th + textH) + (rows + 1) * pad + 60 });
    const g = c.getContext('2d');
    g.fillStyle = '#f6f2ef';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#2d2622';
    g.font = `700 28px ${FONT}`;
    g.fillText('眉型方案比較', pad, 44);
    tiles.forEach((t, i) => {
      const x = pad + (i % cols) * (tw + pad);
      const y = 60 + pad + Math.floor(i / cols) * (th + textH + pad);
      g.fillStyle = '#fff';
      g.fillRect(x, y, tw, th + textH);
      g.drawImage(t.c, x, y);
      g.fillStyle = '#2d2622';
      g.font = `700 26px ${FONT}`;
      g.fillText(t.plan.name, x + 20, y + th + 38);
      g.fillStyle = '#5c524c';
      g.font = `22px ${FONT}`;
      notes[i].forEach((line, j) => g.fillText(line, x + 20, y + th + 74 + j * 32));
    });
    download(await canvasBlob(c), `BrowCanvas-方案比較-${stamp()}.png`);
  }

  function exportProject() {
    const st = A.state;
    const p = st.photo && A.photos.get(st.photo.id);
    const data = { app: 'BrowCanvas', v: 1, saved: new Date().toISOString(), state: st, photo: p?.bytes ? { meta: p.meta, data: toBase64(p.bytes) } : null };
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `BrowCanvas-專案-${stamp()}.json`);
  }

  async function openProject(file) {
    if (!A.net.canEdit) return toast(VIEW_ONLY);
    try {
      const data = JSON.parse(await file.text());
      if (data?.app !== 'BrowCanvas' || !Array.isArray(data.state?.plans) || !data.state.plans.length) throw new Error('not a BrowCanvas project');
      if (data.photo) {
        const bytes = fromBase64(data.photo.data);
        await A.addPhoto(data.photo.meta, bytes);
        A.net.photo(data.photo.meta, bytes);
      }
      A.dispatch({ t: 'replaceAll', state: { ...data.state, lock: A.state.lock } });
      toast('已開啟專案檔');
    } catch (err) {
      console.error('[project] open failed', err);
      toast('這不是 BrowCanvas 專案檔，或檔案已損壞');
    }
  }

  const actions = {
    'png-guides': () => exportFull(true),
    'png-clean': () => exportFull(false),
    compare: exportCompare,
    project: exportProject,
    open: () => $('projectInput').click(),
  };
  for (const b of $$('[data-export]')) {
    b.addEventListener('click', () => {
      $('exportMenu').hidden = true;
      Promise.resolve(actions[b.dataset.export]?.()).catch((err) => {
        console.error('[export] failed', err);
        toast('匯出失敗');
      });
    });
  }
  $('projectInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) openProject(file);
  });
}
