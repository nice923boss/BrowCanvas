import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNet, createHistory, peerIdOf } from '../js/net.js';
import { initialState } from '../js/state.js';

// ---------- fake in-memory transport ----------

function fakeNetwork({ listenError = false } = {}) {
  const servers = new Map();
  const conns = [];

  function pair() {
    const ends = [0, 1].map(() => ({ msg: [], close: [], open: true }));
    const make = (me, other) => ({
      send(m) {
        if (!me.open) return;
        const copy = structuredClone(m);
        queueMicrotask(() => other.open && other.msg.forEach((fn) => fn(copy)));
      },
      onMessage: (fn) => me.msg.push(fn),
      onClose: (fn) => me.close.push(fn),
      close() {
        if (!me.open) return;
        me.open = false;
        other.open = false;
        queueMicrotask(() => {
          me.close.forEach((fn) => fn());
          other.close.forEach((fn) => fn());
        });
      },
    });
    return [make(ends[0], ends[1]), make(ends[1], ends[0])];
  }

  const transport = {
    async listen(id) {
      if (listenError) return { ok: false, reason: 'error' };
      if (servers.has(id)) return { ok: false, reason: 'taken' };
      const srv = { connFns: [], lostFns: [] };
      servers.set(id, srv);
      return {
        ok: true,
        server: {
          onConn: (fn) => srv.connFns.push(fn),
          onLost: (fn) => srv.lostFns.push(fn),
          close: () => servers.delete(id),
        },
      };
    },
    async dial(id) {
      const srv = servers.get(id);
      if (!srv) return null;
      const [hostEnd, clientEnd] = pair();
      conns.push({ hostEnd, clientEnd });
      srv.connFns.forEach((fn) => fn(hostEnd));
      return clientEnd;
    },
  };
  return { transport, servers, conns };
}

function fakeTimers() {
  const timeouts = [];
  return {
    timeouts,
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
    setInterval: () => 1,
    clearInterval: () => {},
    runTimeouts() {
      const list = timeouts.splice(0);
      for (const t of list) t.fn();
    },
  };
}

function peer(net, name, timers) {
  let state = initialState();
  const log = { status: [], members: [], photos: [], leads: [], notices: [] };
  const app = {
    me: { id: name, name },
    getState: () => state,
    setState: (st) => {
      state = st;
    },
    getPhoto: () => null,
    onPhoto: (meta) => log.photos.push(meta),
    onMembers: (list) => log.members.push(list),
    onStatus: (s) => log.status.push(s),
    onCursor: () => {},
    onLead: (l) => log.leads.push(l),
    onHistory: () => {},
    onNotice: (t) => log.notices.push(t),
  };
  const n = createNet({ transport: net.transport, room: 'r1', app, timers, random: () => 0 });
  return { n, app, log, get state() { return state; } };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

async function session(count = 2, { open = false } = {}) {
  const net = fakeNetwork();
  const timers = fakeTimers();
  const peers = [];
  for (let i = 0; i < count; i++) {
    const p = peer(net, `p${i}`, timers);
    await p.n.start();
    await settle();
    peers.push(p);
  }
  if (open) {
    peers[0].n.op({ t: 'setLock', lock: false });
    await settle();
  }
  return { net, timers, peers };
}

// ---------- tests ----------

test('first tab hosts, later tabs join and get the host state', async () => {
  const { net, peers } = await session(3);
  const [host, a, b] = peers;
  assert.equal(host.n.role, 'host');
  assert.equal(a.n.role, 'client');
  assert.equal(b.n.role, 'client');
  assert.ok(net.servers.has(peerIdOf('r1')));
  assert.equal(host.n.members.length, 3);
  assert.deepEqual(a.n.members.map((m) => m.id), ['p0', 'p1', 'p2']);
});

test('a client op reaches the host and the other clients', async () => {
  const { peers } = await session(3, { open: true });
  const [host, a, b] = peers;
  assert.ok(a.n.op({ t: 'setLayers', patch: { oval: true } }));
  assert.equal(a.state.layers.oval, true, 'optimistic local apply');
  await settle();
  assert.equal(host.state.layers.oval, true);
  assert.equal(b.state.layers.oval, true);
  assert.equal(host.state.rev, a.state.rev);
});

test('host status follows the member count', async () => {
  const { peers } = await session(2);
  const [host, a] = peers;
  assert.equal(host.log.status.at(-1).text, '已連線（主機）');
  a.n.stop();
  await settle();
  assert.equal(host.log.status.at(-1).text, '主機（等待其他人加入）');
});

test('host ops reach clients', async () => {
  const { peers } = await session(2);
  const [host, a] = peers;
  host.n.op({ t: 'addPlan', id: 'B', name: '方案 B' });
  await settle();
  assert.deepEqual(a.state.plans.map((p) => p.id), ['A', 'B']);
});

test('by default only the controller (the host) edits; a late op is denied with a forced snapshot', async () => {
  const { net, peers } = await session(2);
  const [host, a] = peers;
  assert.equal(host.n.controller, 'p0');
  assert.equal(a.n.controller, 'p0');
  assert.equal(a.n.canEdit, false);
  assert.equal(host.n.canEdit, true);
  assert.equal(a.n.op({ t: 'setLayers', patch: { ears: true } }), false);

  // an op that was already on its way when the lock landed
  net.conns[0].clientEnd.send({ t: 'op', op: { t: 'setLayers', patch: { ears: true } }, seq: 1 });
  await settle();
  assert.equal(host.state.layers.ears, false);
  assert.equal(a.log.status.at(-1).text, '目前由控制者操作，你只能觀看');
});

test('open editing: everyone edits, but only the controller can lock again or hand over', async () => {
  const { net, peers } = await session(2, { open: true });
  const [host, a] = peers;
  assert.equal(a.n.canEdit, true);
  assert.equal(a.n.op({ t: 'setLock', lock: true }), false);
  assert.equal(a.n.op({ t: 'setControl', id: 'p1' }), false);
  net.conns[0].clientEnd.send({ t: 'op', op: { t: 'setControl', id: 'p1' }, seq: 9 });
  await settle();
  assert.equal(host.state.control, null);
  assert.equal(host.state.lock, false);
});

const wants = (p, id) => p.n.members.find((m) => m.id === id)?.wants;

test('control request: the hint data reaches the controller, approval hands over', async () => {
  const { peers } = await session(3);
  const [host, a, b] = peers;
  a.n.request(true);
  await settle();
  assert.ok(wants(host, 'p1') > 0, 'host sees the request');
  assert.ok(wants(b, 'p1') > 0, 'members list carries it to everyone');

  assert.equal(a.n.answer('p1', true), false, 'a requester cannot approve itself');
  assert.ok(host.n.answer('p1', true));
  await settle();
  for (const p of peers) assert.equal(p.n.controller, 'p1');
  assert.equal(wants(host, 'p1'), 0, 'request cleared after handover');
  assert.equal(a.n.canEdit, true);
  assert.equal(host.n.canEdit, false, 'the host is now view-only');
  assert.equal(b.n.canEdit, false);

  assert.equal(host.n.op({ t: 'setLayers', patch: { oval: true } }), false);
  assert.ok(a.n.op({ t: 'setLayers', patch: { oval: true } }));
  await settle();
  assert.equal(host.state.layers.oval, true);
  assert.equal(b.state.layers.oval, true);
});

test('the new controller approves the next request, even when that is the host', async () => {
  const { peers } = await session(2);
  const [host, a] = peers;
  a.n.request(true);
  await settle();
  host.n.answer('p1', true);
  await settle();
  host.n.request(true);
  await settle();
  assert.ok(wants(a, 'p0') > 0);
  assert.equal(host.n.answer('p0', true), false, 'the old controller cannot take it back');
  assert.ok(a.n.answer('p0', true));
  await settle();
  assert.equal(host.n.controller, 'p0');
  assert.equal(host.n.canEdit, true);
  assert.equal(a.n.canEdit, false);
});

test('deny: the request is cleared and the requester is told', async () => {
  const { peers } = await session(2);
  const [host, a] = peers;
  a.n.request(true);
  await settle();
  host.n.answer('p1', false);
  await settle();
  assert.equal(wants(host, 'p1'), 0);
  assert.equal(a.n.controller, 'p0');
  assert.deepEqual(a.log.notices, ['控制權申請未獲同意']);

  // a client controller denies the host's request through the host
  a.n.request(true);
  await settle();
  host.n.answer('p1', true);
  await settle();
  host.n.request(true);
  await settle();
  a.n.answer('p0', false);
  await settle();
  assert.equal(wants(a, 'p0'), 0);
  assert.deepEqual(host.log.notices, ['控制權申請未獲同意']);
});

test('a requester can withdraw; undo never moves control', async () => {
  const { peers } = await session(2);
  const [host, a] = peers;
  a.n.request(true);
  await settle();
  a.n.request(false);
  await settle();
  assert.equal(wants(host, 'p1'), 0);

  host.n.op({ t: 'setLayers', patch: { ears: true } });
  a.n.request(true);
  await settle();
  host.n.answer('p1', true);
  await settle();
  a.n.undo();
  await settle();
  assert.equal(host.state.layers.ears, false, 'undo restored the drawing');
  assert.equal(host.state.control, 'p1', 'but kept the controller');
  assert.equal(host.state.lock, true);
});

test('controller leaves: control falls back to the host', async () => {
  const { peers } = await session(3);
  const [host, a, b] = peers;
  a.n.request(true);
  await settle();
  host.n.answer('p1', true);
  await settle();
  assert.equal(b.n.controller, 'p1');
  a.n.stop();
  await settle();
  assert.equal(host.n.controller, 'p0');
  assert.equal(b.n.controller, 'p0');
  assert.equal(host.n.canEdit, true);
});

test('control survives the host leaving', async () => {
  const { timers, peers } = await session(3);
  const [host, a, b] = peers;
  b.n.request(true);
  await settle();
  host.n.answer('p2', true);
  await settle();
  host.n.stop();
  await settle();
  timers.runTimeouts();
  await settle();
  assert.equal(a.n.role, 'host');
  assert.equal(b.n.role, 'client');
  assert.equal(a.n.controller, 'p2');
  assert.equal(b.n.canEdit, true);
  assert.equal(a.n.canEdit, false);
});

test('leads go to the controller, not the host', async () => {
  const { peers } = await session(3);
  const [host, a, b] = peers;
  a.n.request(true);
  await settle();
  host.n.answer('p1', true);
  await settle();
  b.n.lead({ name: '林小姐' });
  host.n.lead({ name: '陳先生' });
  await settle();
  assert.equal(host.log.leads.filter((l) => !l.ack).length, 0);
  assert.deepEqual(a.log.leads.map((l) => [l.name, l.via]).sort(), [['林小姐', 'p2'], ['陳先生', 'p0']].sort());
  assert.deepEqual(b.log.leads.at(-1), { ack: true });
  assert.deepEqual(host.log.leads.at(-1), { ack: true });
});

test('undo from a client restores the host state for everyone', async () => {
  const { peers } = await session(2, { open: true });
  const [host, a] = peers;
  a.n.op({ t: 'setLayers', patch: { thirds: true } });
  await settle();
  assert.equal(host.state.layers.thirds, true);
  a.n.undo();
  await settle();
  assert.equal(host.state.layers.thirds, false);
  assert.equal(a.state.layers.thirds, false);
  a.n.undo('redo');
  await settle();
  assert.equal(a.state.layers.thirds, true);
});

test('undo does not cross a photo change', async () => {
  const { peers } = await session(1);
  const [host] = peers;
  host.n.op({ t: 'setLayers', patch: { oval: true } });
  host.n.op({ t: 'setPhoto', photo: { id: 'p2', w: 10, h: 10 }, landmarks: null });
  host.n.undo();
  assert.equal(host.state.photo.id, 'p2');
});

test('no signalling server: solo mode, ops still apply locally', async () => {
  const net = fakeNetwork({ listenError: true });
  const p = peer(net, 'p0', fakeTimers());
  await p.n.start();
  assert.equal(p.n.role, 'solo');
  assert.ok(p.n.op({ t: 'setLayers', patch: { oval: true } }));
  assert.equal(p.state.layers.oval, true);
  assert.equal(p.n.canEdit, true);
});

test('when the host leaves, a client claims the room and keeps its state', async () => {
  const { timers, peers } = await session(2);
  const [host, a] = peers;
  host.n.op({ t: 'setLayers', patch: { ears: true } });
  await settle();
  host.n.stop();
  await settle();
  assert.equal(a.n.role, 'connecting');
  timers.runTimeouts();
  await settle();
  assert.equal(a.n.role, 'host');
  assert.equal(a.state.layers.ears, true);
});

test('leads from a client reach the host and are acknowledged', async () => {
  const { peers } = await session(2);
  const [host, a] = peers;
  a.n.lead({ name: '王小姐', phone: '0912' });
  await settle();
  assert.equal(host.log.leads[0].name, '王小姐');
  assert.equal(host.log.leads[0].via, 'p1');
  assert.deepEqual(a.log.leads.at(-1), { ack: true });
});

test('createHistory coalesces ops with the same key inside the window', () => {
  let now = 0;
  const h = createHistory({ coalesceMs: 800, historyMax: 3 }, () => now);
  h.record('s0', 'drag');
  now = 300;
  h.record('s1', 'drag'); // same step
  now = 2000;
  h.record('s2', 'drag'); // window passed: new step
  assert.equal(h.undo('s3'), 's2');
  assert.equal(h.undo('s2'), 's0');
  assert.equal(h.undo('s0'), null);
  assert.equal(h.redo('s0'), 's2');
  // history is capped
  for (let i = 0; i < 6; i++) h.record(`x${i}`, null);
  let n = 0;
  while (h.undo('c')) n++;
  assert.equal(n, 3);
});
