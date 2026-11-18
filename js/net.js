// Live session: the first tab that claims the room id is the host and holds
// the authoritative state; later tabs dial in. Same idea as taiwan-tycoon,
// reduced to what a shared drawing board needs.
//
// - Local ops apply at once (optimistic) and go to the host; the host applies
//   them in arrival order and relays them; senders skip their own echoes.
// - The host sends a snapshot every few seconds when something changed, with
//   the last op it took from that member, so a member with ops still in
//   flight does not jump back.
// - Undo / redo checkpoints live on the host.
// - Control: state.control names the member who may edit while state.lock is
//   on (an absent member falls back to the host). Anyone may ask for control;
//   requests are transient flags on the host's member list, and the current
//   controller hands over with a setControl op.
// - When the host leaves, members wait a random moment and try to claim the
//   room themselves (the winner keeps its own copy of the state); the rest dial in.
// - No signalling server reachable: solo mode, everything still works locally.
//
// The transport is injected, so tests can drive this with a fake one.

import { applyOp } from './state.js';

export const NET_TIMING = {
  snapMs: 3000, // snapshot / heartbeat interval
  silentMs: 11000, // no message for this long: the connection is treated as lost
  coalesceMs: 800, // ops with the same key within this window share one undo step
  historyMax: 80,
};

const PALETTE = ['#e0565b', '#3a86c8', '#3aa676', '#d08a1e', '#8a5cc2', '#d4547f', '#2f9aa0', '#7c8b2a'];

export function roomIdFrom(loc) {
  const q = new URLSearchParams(loc.search).get('room');
  if (q && /^[a-z0-9-]{3,40}$/i.test(q)) return q.toLowerCase();
  // FNV-1a of origin + path: the same address gives the same room
  let h = 0x811c9dc5;
  for (const ch of loc.origin + loc.pathname) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const peerIdOf = (room) => `browcanvas-${room}`;

export function createHistory(timing = NET_TIMING, clock = Date.now) {
  let past = [];
  let future = [];
  let lastKey = null;
  let lastAt = 0;
  return {
    record(prev, key) {
      const now = clock();
      if (!(key && key === lastKey && now - lastAt < timing.coalesceMs)) {
        past = [...past, prev].slice(-timing.historyMax);
        future = [];
      }
      lastKey = key ?? null;
      lastAt = now;
    },
    undo(cur) {
      if (!past.length) return null;
      const prev = past[past.length - 1];
      past = past.slice(0, -1);
      future = [...future, cur];
      lastKey = null;
      return prev;
    },
    redo(cur) {
      if (!future.length) return null;
      const next = future[future.length - 1];
      future = future.slice(0, -1);
      past = [...past, cur];
      lastKey = null;
      return next;
    },
    reset() {
      past = [];
      future = [];
      lastKey = null;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
  };
}

// Undo must not change the photo: restore everything else, keep photo and
// landmarks of the current state (the bytes may be gone).
function keepPhoto(restored, cur) {
  if (restored.photo?.id === cur.photo?.id) return restored;
  return null;
}

// app: {
//   me: { id, name },
//   getState(), setState(st, reason: 'local' | 'remote' | 'snap'),
//   getPhoto() -> { meta, bytes } | null, onPhoto(meta, bytes),
//   onMembers(list), onStatus({ role, text }), onCursor({ id, name, color, x, y }),
//   onLead(lead), onHistory({ canUndo, canRedo }), onNotice(text)
// }

// ops only the controller may send, even when editing is open to everyone
const CONTROL_OPS = new Set(['setLock', 'setControl']);
export function createNet({ transport, room, app, timing = NET_TIMING, clock = Date.now, random = Math.random, timers = globalThis }) {
  let role = 'connecting'; // 'host' | 'client' | 'solo' | 'connecting'
  let server = null;
  let hostConn = null;
  let seq = 0;
  let stopped = false;
  let snapTimer = null;
  let lastHeard = clock();
  const history = createHistory(timing, clock);
  const members = new Map(); // host: conn -> { id, name, color, ack, sentRev, lastSeen, wants }
  let memberList = [];
  let hostWants = 0; // host: when the host itself asked for control (0: not asking)

  const status = (text) => app.onStatus({ role, text });
  const histChanged = () => app.onHistory({ canUndo: history.canUndo, canRedo: history.canRedo });
  const notice = (text) => app.onNotice?.(text);

  // memberList[0] is the host; with no list yet (solo, starting) it is me
  function controllerId() {
    const c = app.getState().control;
    if (c && memberList.some((m) => m.id === c)) return c;
    return memberList[0]?.id ?? app.me.id;
  }

  function allowed(op, from) {
    if (from === controllerId()) return true;
    return !app.getState().lock && !CONTROL_OPS.has(op?.t);
  }

  // ---------- host ----------

  function colorFor(i) {
    return PALETTE[i % PALETTE.length];
  }

  function publishMembers() {
    memberList = [
      { id: app.me.id, name: app.me.name, color: colorFor(0), host: true, wants: hostWants },
      ...[...members.values()].filter((m) => m.id).map((m) => ({ id: m.id, name: m.name, color: m.color, host: false, wants: m.wants })),
    ];
    app.onMembers(memberList);
    for (const conn of members.keys()) conn.send({ t: 'members', list: memberList });
    status(memberList.length > 1 ? '已連線（主機）' : '主機（等待其他人加入）');
  }

  function broadcast(msg, except = null) {
    for (const conn of members.keys()) if (conn !== except) conn.send(msg);
  }

  const NO_HISTORY = new Set(['setView', 'selectPlan', 'setLock', 'setControl']);

  function hostApply(op, from) {
    const prev = app.getState();
    const next = applyOp(prev, op);
    if (next === prev) return false;
    if (!NO_HISTORY.has(op.t)) history.record(prev, op.k ?? op.t);
    app.setState(next, from === app.me.id ? 'local' : 'remote');
    broadcast({ t: 'op', op, from });
    histChanged();
    if (op.t === 'setControl') setWants(next.control, false);
    return true;
  }

  // host only: set or clear one member's control request
  function setWants(id, on) {
    const at = on ? clock() : 0;
    if (id === app.me.id) hostWants = hostWants && on ? hostWants : at;
    else for (const m of members.values()) if (m.id === id) m.wants = m.wants && on ? m.wants : at;
    if (role === 'host') publishMembers();
  }

  // leads are saved on the controller's device (usually the teacher), not the host's
  function deliverLead(lead) {
    const ctrl = controllerId();
    for (const [conn, m] of members) {
      if (m.id === ctrl) {
        conn.send({ t: 'lead', lead });
        return false;
      }
    }
    app.onLead(lead);
    return true;
  }

  function hostDeny(id) {
    setWants(id, false);
    if (id === app.me.id) return notice('控制權申請未獲同意');
    for (const [conn, m] of members) if (m.id === id) conn.send({ t: 'reqDenied' });
  }

  function hostSetState(st) {
    app.setState(st, 'snap');
    for (const [conn, m] of members) {
      conn.send({ t: 'snap', state: st, ack: m.ack, force: true });
      m.sentRev = st.rev;
    }
    histChanged();
  }

  function hostUndo(dir) {
    const cur = app.getState();
    const restored = dir === 'undo' ? history.undo(cur) : history.redo(cur);
    if (!restored) return;
    const st = keepPhoto(restored, cur);
    if (!st) {
      // crossed a photo change: drop that history
      history.reset();
      histChanged();
      return;
    }
    // undo restores the drawing, never who is in control
    hostSetState({ ...st, lock: cur.lock, control: cur.control, rev: cur.rev + 1 });
  }

  function attach(conn) {
    const m = { id: null, name: '', color: colorFor(members.size + 1), ack: 0, sentRev: -1, lastSeen: clock(), wants: 0 };
    members.set(conn, m);
    conn.onMessage((msg) => {
      m.lastSeen = clock();
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'hello': {
          const first = !m.id;
          m.id = String(msg.id ?? '').slice(0, 40) || `p${members.size}`;
          m.name = String(msg.name ?? '').slice(0, 20) || '成員';
          if (first) {
            const st = app.getState();
            conn.send({ t: 'welcome', state: st, color: m.color });
            m.sentRev = st.rev;
            const ph = app.getPhoto();
            if (ph && st.photo && ph.meta.id === st.photo.id) conn.send({ t: 'photo', meta: ph.meta, bytes: ph.bytes });
          }
          publishMembers();
          break;
        }
        case 'op': {
          m.ack = Math.max(m.ack, msg.seq | 0);
          if (!allowed(msg.op, m.id)) {
            conn.send({ t: 'snap', state: app.getState(), ack: m.ack, force: true, denied: true });
            break;
          }
          hostApply(msg.op, m.id);
          break;
        }
        case 'req':
          setWants(m.id, !!msg.on);
          break;
        case 'deny':
          if (m.id === controllerId()) hostDeny(String(msg.id ?? ''));
          break;
        case 'photo':
          if (!allowed(null, m.id)) break;
          app.onPhoto(msg.meta, msg.bytes);
          broadcast({ t: 'photo', meta: msg.meta, bytes: msg.bytes }, conn);
          break;
        case 'undo':
        case 'redo':
          if (allowed(null, m.id)) hostUndo(msg.t);
          break;
        case 'cur': {
          const c = { t: 'cur', id: m.id, name: m.name, color: m.color, x: msg.x, y: msg.y };
          app.onCursor(c);
          broadcast(c, conn);
          break;
        }
        case 'lead':
          deliverLead({ ...msg.lead, via: m.name });
          conn.send({ t: 'leadAck' });
          break;
        default:
          break;
      }
    });
    conn.onClose(() => {
      const gone = members.get(conn);
      members.delete(conn);
      if (gone?.id) {
        app.onCursor({ id: gone.id, x: null, y: null });
        broadcast({ t: 'cur', id: gone.id, x: null, y: null });
      }
      publishMembers();
    });
  }

  function hostTick() {
    const st = app.getState();
    const now = clock();
    for (const [conn, m] of members) {
      if (now - m.lastSeen > timing.silentMs) {
        conn.close();
        continue;
      }
      if (m.sentRev !== st.rev) {
        conn.send({ t: 'snap', state: st, ack: m.ack });
        m.sentRev = st.rev;
      } else {
        conn.send({ t: 'beat' });
      }
    }
  }

  function becomeHost(srv) {
    role = 'host';
    server = srv;
    hostConn = null;
    srv.onConn(attach);
    srv.onLost(() => {
      if (stopped) return;
      // another tab took the room id: join it
      server = null;
      for (const conn of members.keys()) conn.close();
      members.clear();
      claim();
    });
    publishMembers();
    histChanged();
  }

  // ---------- client ----------

  function becomeClient(conn) {
    role = 'client';
    hostConn = conn;
    seq = 0;
    lastHeard = clock();
    history.reset();
    let welcomed = false;
    conn.onMessage((msg) => {
      lastHeard = clock();
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'welcome':
          welcomed = true;
          app.setState(msg.state, 'snap');
          status('已連線');
          break;
        case 'op':
          if (msg.from !== app.me.id) app.setState(applyOp(app.getState(), msg.op), 'remote');
          break;
        case 'snap': {
          const pending = seq > (msg.ack | 0);
          if (msg.force || (!pending && msg.state.rev !== app.getState().rev)) app.setState(msg.state, 'snap');
          if (msg.denied) status('目前由控制者操作，你只能觀看');
          break;
        }
        case 'reqDenied':
          notice('控制權申請未獲同意');
          break;
        case 'photo':
          app.onPhoto(msg.meta, msg.bytes);
          break;
        case 'members':
          memberList = msg.list;
          app.onMembers(msg.list);
          break;
        case 'cur':
          app.onCursor(msg);
          break;
        case 'leadAck':
          app.onLead({ ack: true });
          break;
        case 'lead':
          app.onLead(msg.lead); // forwarded by the host because we hold control
          break;
        default:
          break;
      }
    });
    conn.onClose(() => {
      if (stopped || hostConn !== conn) return;
      hostConn = null;
      role = 'connecting';
      status('主機離線，重新連線中');
      // random wait so that members do not all claim at once
      timers.setTimeout(claim, 300 + random() * 1500);
    });
    conn.send({ t: 'hello', id: app.me.id, name: app.me.name });
    timers.setTimeout(() => {
      if (!welcomed && hostConn === conn) conn.close();
    }, timing.silentMs);
  }

  function clientTick() {
    if (!hostConn) return;
    if (clock() - lastHeard > timing.silentMs) {
      hostConn.close();
      return;
    }
    hostConn.send({ t: 'beat' });
  }

  // ---------- election ----------

  let claiming = false;
  async function claim() {
    if (stopped || claiming) return;
    claiming = true;
    role = 'connecting';
    status('連線中');
    try {
      for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
        const res = await transport.listen(peerIdOf(room));
        if (stopped) {
          if (res.ok) res.server.close();
          return;
        }
        if (res.ok) {
          becomeHost(res.server);
          return;
        }
        if (res.reason === 'error') break; // no signalling server
        const conn = await transport.dial(peerIdOf(room));
        if (stopped) {
          conn?.close();
          return;
        }
        if (conn) {
          becomeClient(conn);
          return;
        }
      }
      role = 'solo';
      memberList = [];
      status('離線（單機模式）');
      histChanged();
    } finally {
      claiming = false;
    }
  }

  // ---------- public ----------

  return {
    get role() {
      return role;
    },
    get members() {
      return memberList;
    },
    get canEdit() {
      return !app.getState().lock || controllerId() === app.me.id;
    },
    get controller() {
      return controllerId();
    },
    // ask for control (on) or withdraw the request (off)
    request(on = true) {
      if (role === 'client') hostConn.send({ t: 'req', on: !!on });
      else if (role === 'host') setWants(app.me.id, !!on);
    },
    // controller only: hand control to a requester, or turn the request down
    answer(id, yes) {
      if (controllerId() !== app.me.id) return false;
      if (yes) return this.op({ t: 'setControl', id });
      if (role === 'client') hostConn.send({ t: 'deny', id });
      else hostDeny(id);
      return true;
    },
    start() {
      snapTimer = timers.setInterval(() => (role === 'host' ? hostTick() : role === 'client' ? clientTick() : null), timing.snapMs);
      return claim();
    },
    retry() {
      if (role === 'solo') claim();
    },
    op(op) {
      if (!allowed(op, app.me.id)) return false;
      if (role === 'client') {
        const next = applyOp(app.getState(), op);
        if (next === app.getState()) return false;
        app.setState(next, 'local');
        seq += 1;
        hostConn.send({ t: 'op', op, seq });
        return true;
      }
      return hostApply(op, app.me.id); // host, solo, connecting
    },
    photo(meta, bytes) {
      if (role === 'client') hostConn.send({ t: 'photo', meta, bytes });
      else broadcast({ t: 'photo', meta, bytes });
    },
    undo(dir = 'undo') {
      if (role === 'client') hostConn.send({ t: dir });
      else hostUndo(dir);
    },
    cursor(x, y) {
      if (role === 'client') hostConn.send({ t: 'cur', x, y });
      else if (role === 'host') broadcast({ t: 'cur', id: app.me.id, name: app.me.name, color: colorFor(0), x, y });
    },
    lead(lead) {
      if (role === 'client') hostConn.send({ t: 'lead', lead });
      else if (role !== 'host') app.onLead({ ...lead, via: app.me.name });
      else if (!deliverLead({ ...lead, via: app.me.name })) app.onLead({ ack: true });
    },
    rename(name) {
      app.me.name = name;
      if (role === 'client') hostConn?.send({ t: 'hello', id: app.me.id, name });
      else publishMembers();
    },
    stop() {
      stopped = true;
      timers.clearInterval(snapTimer);
      hostConn?.close();
      for (const conn of members.keys()) conn.close();
      server?.close();
    },
  };
}
