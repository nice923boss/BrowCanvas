// Members chip, status dot, control requests and handover, invite link, lock
// and retry, plus the shared open/close behaviour of the top bar menus.
// `A` is the app context.

import { $, $$, el, toast } from './dom.js';
import { clamp } from './geom.js';
import { NET_TIMING } from './net.js';

const DEFAULT_NAME = /^成員\d+$/;
const TAKE_S = Math.round(NET_TIMING.takeoverMs / 1000);
const COOL_MIN = Math.round(NET_TIMING.takeoverCooldownMs / 60000);

export function initSessionUI(A) {
  let list = [];
  let lastCtrl; // controller seen at the last connected render, for the handover toasts
  let shownTk = null; // takeover countdown on screen
  let tickTimer = 0;
  let dismissed = null; // requester whose countdown this controller already answered

  function renderMembers(next) {
    list = next;
    syncControl();
  }

  function syncControl() {
    const net = A.net;
    if (!net) return;
    const ctrl = net.controller;
    const online = net.role === 'host' || net.role === 'client';
    const shown = list.length ? list : [{ id: A.me.id, name: A.me.name, color: '#d08a1e', host: true }];
    const nameOf = (id) => shown.find((m) => m.id === id)?.name ?? '主機';
    const iCtrl = ctrl === A.me.id;
    const mine = !iCtrl && !!shown.find((m) => m.id === A.me.id)?.wants;
    const reqs = iCtrl ? shown.filter((m) => m.wants && m.id !== ctrl).sort((a, b) => a.wants - b.wants) : [];

    if (online && list.length && lastCtrl !== undefined && ctrl !== lastCtrl) {
      if (iCtrl) toast('你已取得控制權');
      else if (lastCtrl === A.me.id) toast(`控制權已交給 ${nameOf(ctrl)}`);
    }
    if (online && list.length) lastCtrl = ctrl;

    $('memberCount').textContent = String(shown.length);
    $('memberList').replaceChildren(
      ...shown.map((m) => {
        const dot = el('i');
        dot.style.setProperty('--c', m.color);
        return el('li', {}, [
          dot,
          el('span', { textContent: m.name }),
          m.id === ctrl ? el('small', { className: 'badge', textContent: '控制中' }) : null,
          m.host ? el('small', { textContent: '主機' }) : null,
          m.wants && m.id !== ctrl ? el('small', { textContent: '申請中' }) : null,
          m.id === A.me.id ? el('small', { textContent: '（我）' }) : null,
        ]);
      }),
    );

    const tk = online ? net.takeover : null;
    const myTk = tk?.id === A.me.id;
    $('btnTakeover').hidden = !online || iCtrl;
    $('btnTakeover').textContent = myTk ? '取消要求接手' : '要求接手（控制者沒回應時）';
    $('btnBannerTake').hidden = !online;
    $('btnBannerTake').textContent = myTk ? '取消接手' : '要求接手';
    syncTakeover(tk, iCtrl, nameOf);
    if (tk) return syncRest();

    // small hint left of the members chip
    const hint = $('reqHint');
    hint.hidden = !online || !(reqs.length || mine);
    let text = '';
    if (reqs.length) text = `${reqs[0].name} 申請控制${reqs.length > 1 ? `（共 ${reqs.length} 人）` : ''}`;
    else if (mine) text = '已申請控制，等待同意';
    const fresh = reqs.length && hint.textContent !== text;
    hint.textContent = text;
    hint.className = `chip req${mine ? ' mine' : ''}${fresh || (reqs.length && hint.dataset.ask) ? ' ask' : ''}`;
    hint.dataset.ask = reqs.length ? '1' : '';
    $('reqList').replaceChildren(
      ...(reqs.length
        ? reqs.map((m) =>
            el('li', {}, [
              el('span', { textContent: m.name }),
              el('span', { className: 'acts' }, [
                el('button', { className: 'yes', textContent: '同意', onclick: () => A.net.answer(m.id, true) }),
                el('button', { textContent: '拒絕', onclick: () => A.net.answer(m.id, false) }),
              ]),
            ]),
          )
        : mine
          ? [
              el('li', {}, [
                el('span', { textContent: `等待 ${nameOf(ctrl)} 同意` }),
                el('span', { className: 'acts' }, [el('button', { textContent: '取消申請', onclick: () => A.net.request(false) })]),
              ]),
            ]
          : []),
    );
    if (hint.hidden) $('reqMenu').hidden = true;
    syncRest();

    function syncRest() {
      $('btnRequest').hidden = !online || iCtrl;
      $('btnRequest').textContent = mine ? '取消控制申請' : '申請控制畫面';
      $('btnLock').hidden = !online || !iCtrl;
      $('btnLock').textContent = A.state.lock ? '開放所有人編輯' : '只讓控制者編輯';
      $('lockText').textContent = `目前由 ${nameOf(ctrl)} 控制，你只能觀看。`;
      $('btnBannerReq').hidden = !online;
      $('btnBannerReq').textContent = mine ? '取消申請' : '申請控制';
    }
  }

  // takeover countdown: the hint chip for everyone, a modal for the controller
  function syncTakeover(tk, iCtrl, nameOf) {
    clearInterval(tickTimer);
    shownTk = tk;
    const dlg = $('dlgTakeover');
    if (!tk) {
      dismissed = null;
      if (dlg.open) dlg.close();
      return;
    }
    const who = nameOf(tk.id);
    const mine = tk.id === A.me.id;
    const hint = $('reqHint');
    hint.hidden = false;
    hint.className = `chip req${mine ? ' mine' : iCtrl ? ' ask' : ''}`;
    hint.dataset.ask = '';
    const acts = iCtrl
      ? [
          el('button', { textContent: '不移轉', onclick: keep }),
          el('button', { className: 'yes', textContent: '立即移交', onclick: () => A.net.answer(tk.id, true) }),
        ]
      : mine
        ? [el('button', { textContent: '取消要求', onclick: () => A.net.claimControl(false) })]
        : [];
    const label = iCtrl ? `${who} 要求接手` : mine ? '倒數結束就由你控制' : `${who} 要求接手，倒數結束後取得控制權`;
    $('reqList').replaceChildren(el('li', {}, [el('span', { textContent: label }), el('span', { className: 'acts' }, acts)]));
    $('takeWho').textContent = who;
    $('takeText').textContent = `倒數結束前沒有按「不移轉」，控制權會自動交給 ${who}。按「不移轉」後 ${COOL_MIN} 分鐘內不會再收到接手要求。`;
    $('btnKeep').textContent = `不移轉（${COOL_MIN} 分鐘內不再詢問）`;
    if (iCtrl && !dlg.open && dismissed !== tk.id) dlg.showModal();
    if (!iCtrl && dlg.open) dlg.close();
    const paint = () => {
      const s = Math.max(0, Math.ceil((tk.until - Date.now()) / 1000));
      hint.textContent = mine ? `要求接手中，${s} 秒` : `${who} 要求接手，${s} 秒`;
      $('takeSecs').textContent = String(s);
    };
    paint();
    tickTimer = setInterval(paint, 250);
  }

  function keep() {
    dismissed = shownTk?.id ?? null;
    A.net.keepControl();
    $('dlgTakeover').close();
    toast(`已保留控制權，${COOL_MIN} 分鐘內不會再收到接手要求`);
  }
  $('btnKeep').addEventListener('click', keep);
  $('btnGiveNow').addEventListener('click', () => {
    if (shownTk) A.net.answer(shownTk.id, true);
    dismissed = shownTk?.id ?? null;
    $('dlgTakeover').close();
  });
  // Escape must not hide the countdown while it still runs
  $('dlgTakeover').addEventListener('cancel', (e) => e.preventDefault());

  function askTakeover() {
    if (A.net.takeover?.id === A.me.id) {
      A.net.claimControl(false);
      toast('已取消接手要求');
      return;
    }
    for (const m of $$('.menu')) m.hidden = true;
    $('claimText').textContent = `控制者離開或沒有回應時使用。控制者會看到 ${TAKE_S} 秒倒數，時間內沒有按「不移轉」，控制權就交給你；控制者按「不移轉」後，${COOL_MIN} 分鐘內無法再要求接手。`;
    $('claimName').value = A.me.name;
    $('dlgClaim').showModal();
    if (DEFAULT_NAME.test(A.me.name)) $('claimName').select();
  }
  $('btnTakeover').addEventListener('click', askTakeover);
  $('btnBannerTake').addEventListener('click', askTakeover);
  $('btnSendClaim').addEventListener('click', () => {
    setName($('claimName').value);
    A.net.claimControl(true);
    $('dlgClaim').close();
  });

  function askControl() {
    const me = A.net.members.find((m) => m.id === A.me.id);
    if (me?.wants) return A.net.request(false);
    for (const m of $$('.menu')) m.hidden = true;
    $('reqName').value = A.me.name;
    $('dlgRequest').showModal();
    if (DEFAULT_NAME.test(A.me.name)) $('reqName').select();
  }
  $('btnRequest').addEventListener('click', askControl);
  $('btnBannerReq').addEventListener('click', askControl);
  $('btnSendReq').addEventListener('click', () => {
    setName($('reqName').value);
    A.net.request(true);
    $('dlgRequest').close();
    toast('已送出申請，等待控制者同意');
  });

  function renderStatus({ role, text }) {
    $('netDot').className = `dot ${['host', 'client', 'solo'].includes(role) ? role : ''}`;
    $('netText').textContent = text;
    $('btnRetry').hidden = role !== 'solo';
    if (role === 'solo') renderMembers([{ id: A.me.id, name: A.me.name, color: '#d08a1e', host: true }]);
    A.changed();
  }

  function openMenu(menu, anchor) {
    const open = menu.hidden;
    for (const m of $$('.menu')) m.hidden = true;
    if (!open) return;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${clamp(r.right - w, 8, window.innerWidth - w - 8)}px`;
  }
  for (const [btn, menu] of [['btnMembers', 'memberMenu'], ['btnExport', 'exportMenu'], ['reqHint', 'reqMenu']]) {
    $(btn).addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu($(menu), $(btn));
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) for (const m of $$('.menu')) m.hidden = true;
  });

  function setName(raw) {
    const name = String(raw).trim().slice(0, 20) || A.me.name;
    $('myName').value = name;
    if (name === A.me.name) return;
    A.me.name = name;
    try {
      localStorage.setItem('browcanvas.name', name);
    } catch {
      /* storage blocked: the name lasts for this tab only */
    }
    A.net.rename(name);
  }
  $('myName').value = A.me.name;
  $('myName').addEventListener('change', (e) => setName(e.target.value));
  $('btnLock').addEventListener('click', () => A.dispatch({ t: 'setLock', lock: !A.state.lock }));
  $('btnRetry').addEventListener('click', () => A.net.retry());

  function inviteUrl() {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', A.room);
    return u.toString();
  }
  $('btnInvite').addEventListener('click', () => {
    $('inviteLink').value = inviteUrl();
    $('inviteWarn').hidden = !/^(localhost|127\.|\[::1\])/.test(location.hostname);
    $('dlgInvite').showModal();
  });
  $('btnCopyInvite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('inviteLink').value);
      toast('已複製邀請連結');
    } catch {
      $('inviteLink').select();
      toast('請按 Ctrl+C 複製');
    }
  });

  return { renderMembers, renderStatus, syncControl };
}
