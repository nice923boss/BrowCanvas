// Customer records and lead / booking requests. Records are stored on this
// device only (store.js); leads travel to the host through the live session.
// `A` is the app context built in app.js. Remote text only ever goes through
// textContent.

import { $, $$, el, toast, stamp, download } from './dom.js';
import * as store from './store.js';

const PREFS = ['自然', '濃一點', '淡一點', '平眉', '有弧度', '上揚有精神', '溫柔', '俐落', '顯年輕', '不要太細', '好整理', '眉頭要淡'];
const str = (v, n) => String(v ?? '').slice(0, n);

export function initRecords(A) {
  let ctab = 'customers';
  for (const name of PREFS) $('prefChips').append(el('label', {}, [el('input', { type: 'checkbox', name: 'pref', value: name }), name]));

  function planOptions(select) {
    const st = A.state;
    const cur = select.value;
    select.replaceChildren(...st.plans.map((p) => el('option', { value: p.id, textContent: p.name })), el('option', { value: '', textContent: '還沒決定' }));
    select.value = st.plans.some((p) => p.id === cur) ? cur : st.active;
  }

  function clearCustForm() {
    const f = $('custForm');
    f.reset();
    f.elements.id.value = '';
    planOptions($('custPlan'));
  }

  function fillCustForm(r) {
    const f = $('custForm');
    planOptions($('custPlan'));
    f.elements.id.value = r.id;
    f.elements.name.value = r.name ?? '';
    f.elements.contact.value = r.contact ?? '';
    f.elements.prefText.value = r.prefText ?? '';
    f.elements.note.value = r.note ?? '';
    for (const c of $$('input[name=pref]', f)) c.checked = (r.prefs ?? []).includes(c.value);
    if (A.state.plans.some((p) => p.id === r.planId)) f.elements.plan.value = r.planId;
  }

  function leadToCustomer(r) {
    ctab = 'customers';
    renderRecords();
    clearCustForm();
    const f = $('custForm');
    f.elements.name.value = r.name ?? '';
    f.elements.contact.value = [r.phone, r.line && `LINE ${r.line}`].filter(Boolean).join(' ');
    f.elements.note.value = r.message ?? '';
  }

  function infoOf(r) {
    const when = new Date(r.updated ?? r.created ?? 0).toLocaleString('zh-TW');
    if (ctab === 'customers') {
      return [
        el('b', { textContent: r.name }),
        el('div', { textContent: [r.contact, (r.prefs ?? []).join('、'), r.prefText].filter(Boolean).join('｜') }),
        el('div', { className: 'hint', textContent: `方案：${r.planName || '未定'}　${r.note || ''}　${when}` }),
      ];
    }
    return [
      el('b', { textContent: r.name }),
      el('div', { textContent: [r.phone, r.line && `LINE ${r.line}`, r.when && `希望 ${r.when.replace('T', ' ')}`].filter(Boolean).join('｜') }),
      el('div', { textContent: [r.planName && `方案：${r.planName}`, r.message].filter(Boolean).join('　') }),
      el('div', { className: 'hint', textContent: `${when}${r.via ? `　來自 ${r.via}` : ''}` }),
    ];
  }

  async function renderRecords() {
    for (const b of $$('[data-ctab]')) b.classList.toggle('on', b.dataset.ctab === ctab);
    $('custForm').hidden = ctab !== 'customers';
    const box = $('custList');
    let items;
    try {
      items = await store.list(ctab);
    } catch (err) {
      console.error('[store] list failed', err);
      box.replaceChildren(el('p', { className: 'hint warn', textContent: '這個瀏覽器無法存取本機資料庫（可能是無痕模式）' }));
      return;
    }
    if (!items.length) {
      box.replaceChildren(el('p', { className: 'hint', textContent: ctab === 'customers' ? '還沒有顧客紀錄。' : '還沒有收到留資或預約。' }));
      return;
    }
    const tab = ctab;
    box.replaceChildren(
      ...items.map((r) => {
        const acts = el('div', { className: 'acts' }, [
          tab === 'customers'
            ? el('button', { className: 'btn small', type: 'button', textContent: '編輯', onclick: () => fillCustForm(r) })
            : el('button', { className: 'btn small', type: 'button', textContent: '轉成顧客', onclick: () => leadToCustomer(r) }),
          el('button', {
            className: 'btn small danger',
            type: 'button',
            textContent: '刪除',
            onclick: async () => {
              if (!confirm(`刪除「${r.name}」的資料？刪除後無法復原。`)) return;
              await store.remove(tab, r.id);
              renderRecords();
            },
          }),
        ]);
        return el('div', { className: 'cust' }, [r.thumb ? el('img', { src: r.thumb, alt: '' }) : null, el('div', { className: 'info' }, infoOf(r)), acts]);
      }),
    );
  }

  $('btnCustomers').addEventListener('click', () => {
    clearCustForm();
    renderRecords();
    $('dlgCustomers').showModal();
  });
  for (const b of $$('[data-ctab]')) b.addEventListener('click', () => {
    ctab = b.dataset.ctab;
    renderRecords();
  });
  $('custNew').addEventListener('click', clearCustForm);
  $('custForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const plan = A.state.plans.find((p) => p.id === f.elements.plan.value) ?? null;
    const thumb = plan ? A.planCanvas(plan, 480) : null;
    const now = Date.now();
    try {
      const prev = f.elements.id.value ? (await store.list('customers')).find((x) => x.id === f.elements.id.value) : null;
      const rec = {
        id: f.elements.id.value || store.newId(),
        name: f.elements.name.value.trim(),
        contact: f.elements.contact.value.trim(),
        prefs: $$('input[name=pref]:checked', f).map((c) => c.value),
        prefText: f.elements.prefText.value.trim(),
        note: f.elements.note.value.trim(),
        planId: plan?.id ?? '',
        planName: plan?.name ?? '',
        planNote: plan?.note ?? '',
        brows: plan?.brows ?? null,
        thumb: thumb ? thumb.toDataURL('image/jpeg', 0.8) : prev?.thumb ?? '',
        created: prev?.created ?? now,
        updated: now,
      };
      await store.put('customers', rec);
      toast(`已儲存 ${rec.name}`);
      clearCustForm();
      renderRecords();
    } catch (err) {
      console.error('[store] save failed', err);
      toast('儲存失敗：這個瀏覽器無法存取本機資料庫');
    }
  });
  $('custExport').addEventListener('click', async () => {
    try {
      const data = { app: 'BrowCanvas', kind: 'records', exported: new Date().toISOString(), customers: await store.list('customers'), leads: await store.list('leads') };
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `BrowCanvas-顧客紀錄-${stamp()}.json`);
    } catch (err) {
      console.error('[store] export failed', err);
      toast('匯出失敗');
    }
  });

  // lead / booking form (anyone in the session)
  $('btnLead').addEventListener('click', () => {
    $('leadForm').reset();
    planOptions($('leadPlan'));
    $('dlgLead').showModal();
  });
  $('leadForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const plan = A.state.plans.find((p) => p.id === f.plan.value);
    A.net.lead({
      name: f.name.value.trim().slice(0, 30),
      phone: f.phone.value.trim().slice(0, 30),
      line: f.line.value.trim().slice(0, 40),
      when: f.when.value,
      planId: plan?.id ?? '',
      planName: plan?.name ?? '',
      message: f.message.value.trim().slice(0, 500),
    });
    $('dlgLead').close();
    if (A.net.role === 'client') toast('已送出，等待確認');
  });

  // controller / solo side: a lead arrived (or our own lead was acknowledged)
  async function receiveLead(lead) {
    if (lead.ack) return toast('資料已送到控制畫面的人');
    const now = Date.now();
    const rec = {
      id: store.newId(),
      name: str(lead.name, 30),
      phone: str(lead.phone, 30),
      line: str(lead.line, 40),
      when: str(lead.when, 20),
      planId: str(lead.planId, 40),
      planName: str(lead.planName, 30),
      message: str(lead.message, 500),
      via: str(lead.via, 20),
      created: now,
      updated: now,
    };
    try {
      await store.put('leads', rec);
      toast(`收到 ${rec.name || '顧客'} 的留資／預約，存在「顧客紀錄」`);
    } catch (err) {
      console.error('[store] lead save failed', err);
      toast('收到留資，但這個瀏覽器無法保存');
    }
  }

  return { receiveLead };
}
