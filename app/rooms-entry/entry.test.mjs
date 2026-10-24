import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntryAdapter, evaluateReadiness, EntryError } from './index.mjs';
import { createEntryServer } from './server.mjs';
import { fixtureRooms, fixturePorts } from './fixtures.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wittle-entry-'));
  let time = Date.parse('2026-10-24T18:00:00.000Z');
  const now = () => time;
  const path = join(root, 'entry.sqlite');
  const dbs = [];
  const open = () => { const db = new DatabaseSync(path); dbs.push(db); return db; };
  t.after(async () => { for (const db of dbs) { try { db.close(); } catch {} } await rm(root, { recursive: true, force: true }); });
  const rooms = fixtureRooms(time);
  const ports = fixturePorts(rooms, { now });
  const config = { enabled: true, ...options };
  const db = open();
  const adapter = createEntryAdapter(db, config, { now, ...ports });
  adapter.addRooms(rooms);
  return { root, rooms, ports, now, config, db, adapter, open, advance: ms => { time += ms; } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof EntryError && error.code === code);
const request = request_id => ({ request_id });

// Two connections exercise durable SQLite arbitration, not only one in-memory lock.
test('concurrent buyers get distinct private rooms; same-key races reuse one committed outcome', async t => {
  const f = await setup(t);
  const other = createEntryAdapter(f.open(), f.config, { now: f.now, ...f.ports });
  const [a, b] = await Promise.all([
    f.adapter.allocate('browser_a', request('request_a_0001')),
    other.allocate('browser_b', request('request_b_0001')),
  ]);
  assert.notEqual(a.room_id, b.room_id);
  const [c, retry] = await Promise.all([
    f.adapter.allocate('browser_c', request('request_c_0001')),
    other.allocate('browser_c', request('request_c_0001')),
  ]);
  assert.deepEqual(c, retry);
  assert.equal(new Set([a.room_id, b.room_id, c.room_id]).size, 3);
  await rejectsCode(f.adapter.allocate('browser_d', request('request_d_0001')), 'RUNTIME_UNAVAILABLE');
  assert.deepEqual(await other.allocate('browser_a', request('request_a_0001')), a);
});

test('lost response and process restart preserve exact join URL, expiry and attribution', async t => {
  const f = await setup(t);
  const input = { request_id: 'request_lost_01', ref: 'fixture_lead' };
  const original = await f.adapter.allocate('browser_a', input);
  assert.equal(original.join_url, f.rooms[0].join_url);
  f.db.close();
  const restarted = createEntryAdapter(f.open(), f.config, { now: f.now, ...f.ports });
  f.advance(10_000);
  assert.deepEqual(await restarted.allocate('browser_a', input), original);
  await rejectsCode(restarted.allocate('browser_a', { ...input, ref: 'changed_lead' }), 'CONFLICT');
  await rejectsCode(restarted.allocate('browser_a', request('new_request_0001')), 'CONFLICT');
});

test('cross-browser key replay cannot disclose or consume a room', async t => {
  const f = await setup(t);
  const a = await f.adapter.allocate('browser_a', request('shared_request_01'));
  const errors = await Promise.allSettled([
    f.adapter.allocate('browser_b', request('shared_request_01')),
    f.adapter.allocate('browser_c', request('shared_request_01')),
  ]);
  for (const error of errors) {
    assert.equal(error.status, 'rejected');
    assert.deepEqual(error.reason.body, { code: 'FORBIDDEN', retryable: false, next_action: 'stop' });
    assert.ok(!JSON.stringify(error.reason.body).includes(a.join_url));
  }
  const [b, c] = await Promise.all([
    f.adapter.allocate('browser_b', request('request_b_0001')),
    f.adapter.allocate('browser_c', request('request_c_0001')),
  ]);
  assert.equal(new Set([a.room_id, b.room_id, c.room_id]).size, 3);
});

test('unknown fields, forged principal/identity and invalid URLs fail before allocation', async t => {
  const f = await setup(t);
  for (const body of [null, [], { request_id: 'request_0001', buyer_id: 'forged' }, { request_id: 'request_0001', entry_principal_id: 'forged' }, { request_id: 'request_0001', credential_boundary_verified: true }, { request_id: 'short' }]) {
    await rejectsCode(f.adapter.allocate('browser_a', body), 'INVALID_INPUT');
  }
  await rejectsCode(f.adapter.allocate('forged,principal', request('request_0001')), 'INVALID_INPUT');
  for (const url of ['https://attacker.example/r/link', 'https://user@rooms.wittlelabs.ai/r/link', 'https://rooms.wittlelabs.ai\\@attacker.example/link', 'javascript:alert(1)']) {
    assert.throws(() => f.adapter.addRooms([{ ...f.rooms[0], room_id: 'new_room', join_url: url }]), error => error.code === 'INVALID_INPUT');
  }
  assert.equal((await f.adapter.allocate('browser_a', request('request_0001'))).room_id, f.rooms[0].room_id);
});

test('readiness rejects malformed, stale, expired, unproven and insufficient-runtime snapshots', async t => {
  const f = await setup(t);
  const positive = (await f.ports.readReadiness()).readiness;
  const cases = [
    [null, 'unknown'],
    [{ ...positive, credential_boundary_verified: false }, 'credential_boundary_unverified'],
    [{ ...positive, observed_at: new Date(f.now() - 30_001).toISOString() }, 'stale'],
    [{ ...positive, stale: true }, 'stale'],
    [{ ...positive, expires_at: new Date(f.now() + 1000).toISOString() }, 'runtime_expired'],
    [{ ...positive, expires_at: new Date(f.now() - 1).toISOString(), observed_at: new Date(f.now() - 1000).toISOString() }, 'runtime_expired'],
    [{ ...positive, observed_at: new Date(f.now() + 1).toISOString() }, 'unknown'],
    [{ ...positive, membership_ready: false }, 'membership_unverified'],
    [{ ...positive, host_lead_ready: false }, 'host_unavailable'],
    [{ ...positive, available_slots: 0 }, 'capacity_full'],
    [{ ...positive, available_slots: null }, 'capacity_full'],
    [{ ...positive, entry_available: false }, 'entry_unavailable'],
    [{ ...positive, quoting_available: false }, 'terms_unavailable'],
    [{ ...positive, extra: true }, 'unknown'],
  ];
  for (const [readiness, reason] of cases) {
    const adapter = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, readReadiness: async () => ({ mode: 'fixture', evidence_level: 'fixture', readiness }) });
    assert.equal((await adapter.readiness()).reason, reason);
    await rejectsCode(adapter.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  }
  assert.equal((await f.adapter.allocate('browser_a', request('request_0001'))).room_id, f.rooms[0].room_id);
});

test('free scoping opens without paid terms but never grants paid quoting or changes paid defaults', async t => {
  const f = await setup(t);
  const source = (await f.ports.readReadiness()).readiness;
  const readiness = { ...source, quoting_available: false, reason: 'terms_unavailable' };
  const ports = { now: f.now, ...f.ports, readReadiness: async () => ({ mode: 'fixture', evidence_level: 'fixture', readiness }) };
  const paid = createEntryAdapter(f.db, f.config, ports);
  const free = createEntryAdapter(f.db, { ...f.config, purpose: 'free_scoping' }, ports);
  assert.equal((await paid.readiness()).reason, 'terms_unavailable');
  await rejectsCode(paid.allocate('browser_a', request('free_request_0001')), 'RUNTIME_UNAVAILABLE');
  assert.deepEqual(await free.readiness(), { ...readiness, entry_available: true, quoting_available: false, reason: null });
  const allocated = await free.allocate('browser_a', request('free_request_0001'));
  assert.deepEqual(allocated, { room_id: f.rooms[0].room_id, join_url: f.rooms[0].join_url, expires_at: source.expires_at, mode: 'fixture' });
  await rejectsCode(paid.getRoomBinding(allocated.room_id), 'RUNTIME_UNAVAILABLE');
  assert.equal(evaluateReadiness(source, { now: f.now(), purpose: 'free_scoping' }).quoting_available, false);
  assert.throws(() => createEntryAdapter(f.db, { purpose: 'unknown' }), error => error.code === 'INVALID_INPUT');
});

test('free scoping still requires all independent safety proofs and preserves non-terms source denial', async t => {
  const f = await setup(t);
  const source = { ...(await f.ports.readReadiness()).readiness, quoting_available: false, reason: 'terms_unavailable' };
  for (const [patch, reason] of [
    [{ credential_boundary_verified: false }, 'credential_boundary_unverified'],
    [{ membership_ready: false }, 'membership_unverified'],
    [{ host_lead_ready: false }, 'host_unavailable'],
    [{ available_slots: 0 }, 'capacity_full'],
    [{ available_slots: null }, 'capacity_full'],
    [{ stale: true }, 'stale'],
    [{ observed_at: new Date(f.now() - 30_001).toISOString() }, 'stale'],
    [{ expires_at: new Date(f.now() + 1000).toISOString() }, 'runtime_expired'],
    [{ entry_available: false }, 'entry_unavailable'],
    [{ reason: 'unknown' }, 'unknown'],
    [{ reason: 'host_unavailable' }, 'host_unavailable'],
  ]) {
    const free = createEntryAdapter(f.db, { ...f.config, purpose: 'free_scoping' }, {
      now: f.now, ...f.ports, readReadiness: async () => ({ mode: 'fixture', evidence_level: 'fixture', readiness: { ...source, ...patch } }),
    });
    assert.equal((await free.readiness()).reason, reason);
    await rejectsCode(free.allocate('browser_a', request('free_request_0001')), 'RUNTIME_UNAVAILABLE');
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entry_allocations').get().n, 0);
});

test('free scoping cannot promote local evidence, bypass live release or skip current room proof', async t => {
  const f = await setup(t, { purpose: 'free_scoping' });
  const readiness = { ...(await f.ports.readReadiness()).readiness, quoting_available: false, reason: null };
  const local = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports,
    readReadiness: async () => ({ mode: 'fixture', evidence_level: 'local_execution', readiness }),
  });
  await rejectsCode(local.allocate('browser_a', request('free_request_0001')), 'RUNTIME_UNAVAILABLE');
  const unsafe = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async input => ({
    ...(await f.ports.verifyRoom(input)), unexpected_members: true,
  }) });
  await rejectsCode(unsafe.allocate('browser_a', request('free_request_0001')), 'RUNTIME_UNAVAILABLE');
  const liveDb = new DatabaseSync(':memory:'); t.after(() => liveDb.close());
  let calls = 0;
  const live = createEntryAdapter(liveDb, { enabled: true, mode: 'live', purpose: 'free_scoping' }, {
    readReadiness: async () => { calls++; return { mode: 'live', evidence_level: 'provider', readiness }; },
  });
  assert.equal((await live.readiness()).reason, 'entry_unavailable');
  assert.equal(calls, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entry_allocations').get().n, 0);
});

test('missing provider ports, wrong evidence/mode and default-disabled configuration never consume rooms', async t => {
  const f = await setup(t);
  for (const [config, ports] of [
    [{}, f.ports],
    [f.config, {}],
    [f.config, { ...f.ports, readReadiness: async () => ({ ...(await f.ports.readReadiness()), mode: 'sandbox' }) }],
    [f.config, { ...f.ports, readReadiness: async () => ({ ...(await f.ports.readReadiness()), evidence_level: 'provider' }) }],
    [f.config, { readReadiness: f.ports.readReadiness }],
  ]) {
    const adapter = createEntryAdapter(f.db, config, { now: f.now, ...ports });
    await rejectsCode(adapter.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  }
  const sandboxDb = new DatabaseSync(':memory:'); t.after(() => sandboxDb.close());
  const sandbox = createEntryAdapter(sandboxDb, { enabled: true, mode: 'sandbox' }, { now: f.now, ...f.ports });
  assert.equal((await sandbox.readiness()).entry_available, false);
  const liveDb = new DatabaseSync(':memory:'); t.after(() => liveDb.close());
  const live = createEntryAdapter(liveDb, { enabled: true, mode: 'live' }, { now: f.now, ...f.ports });
  assert.equal((await live.readiness()).entry_available, false);
  assert.throws(() => createEntryAdapter(f.db, { mode: 'sandbox' }, {}), error => error.code === 'CONFLICT');
  assert.equal((await f.adapter.allocate('browser_a', request('request_0001'))).room_id, f.rooms[0].room_id);
});

test('fresh room attestation must match room/link, private lead and unused membership before a new allocation', async t => {
  const f = await setup(t);
  for (const patch of [
    { room_id: 'wrong_room' }, { join_url: f.rooms[1].join_url }, { private: false },
    { host_lead_ready: false }, { unexpected_members: true }, { unused: false },
    { observed_at: new Date(f.now() - 30_001).toISOString() },
    { expires_at: new Date(f.now() - 1).toISOString() }, { evidence_level: 'provider' },
  ]) {
    const adapter = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async input => ({ ...(await f.ports.verifyRoom(input)), ...patch }) });
    await rejectsCode(adapter.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  }
  const first = await f.adapter.allocate('browser_a', request('request_0001'));
  const joined = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async input => ({ ...(await f.ports.verifyRoom(input)), unused: false }) });
  assert.deepEqual(await joined.allocate('browser_a', request('request_0001')), first);
  // A current unexpected-member observation must still block an allocated room's join-link replay.
  const revoked = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async input => ({ ...(await f.ports.verifyRoom(input)), unexpected_members: true }) });
  await rejectsCode(revoked.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
});

test('read-only provider errors/timeouts cause no reservation and safe retry reuses first pool room', async t => {
  const f = await setup(t);
  const broken = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async () => { throw new Error('private upstream diagnostic'); } });
  await rejectsCode(broken.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  const stalled = createEntryAdapter(f.db, { ...f.config, portTimeoutMs: 10 }, { now: f.now, ...f.ports, verifyRoom: () => new Promise(() => {}) });
  await rejectsCode(stalled.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  assert.equal((await f.adapter.allocate('browser_a', request('request_0001'))).room_id, f.rooms[0].room_id);
});

test('expiry and stopped readiness block retry without recycling used rooms', async t => {
  const f = await setup(t);
  const first = await f.adapter.allocate('browser_a', request('request_0001'));
  f.advance(600_001);
  await rejectsCode(f.adapter.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  const second = await f.adapter.allocate('browser_b', request('request_0002'));
  assert.notEqual(second.room_id, first.room_id);
  assert.throws(() => f.adapter.addRooms([{ ...f.rooms[0], join_url: f.rooms[1].join_url }]), error => error.code === 'CONFLICT');
});

test('readiness expiration while provider read is in flight prevents committing an allocation', async t => {
  const f = await setup(t);
  const adapter = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async input => {
    const proof = await f.ports.verifyRoom(input); f.advance(600_001); return proof;
  } });
  await rejectsCode(adapter.allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  assert.equal((await f.adapter.allocate('browser_a', request('request_0001'))).room_id, f.rooms[0].room_id);
});

test('HTTP entry requires server token and trusted principal; prefetch and forged body never allocate', async t => {
  const f = await setup(t);
  const token = 'synthetic-allocation-token-for-local-tests-only';
  const server = createEntryServer(f.adapter, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Wittle-Entry-Principal': 'browser_a' };
  const post = (body, override = {}) => fetch(`${base}/entry`, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/entry`, { headers: { ...headers, Purpose: 'prefetch' } })).status, 405);
  assert.equal((await fetch(`${base}/entry`, { method: 'HEAD', headers })).status, 405);
  assert.equal((await post(request('request_0001'), { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await post(request('request_0001'), { 'X-Wittle-Entry-Principal': '' })).status, 400);
  assert.equal((await post({ ...request('request_0001'), entry_principal_id: 'browser_forged' })).status, 400);
  const response = await post(request('request_0001'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const result = await response.json();
  assert.equal(result.room_id, f.rooms[0].room_id);
  assert.equal(result.mode, 'fixture');
  const attack = await post(request('request_0001'), { 'X-Wittle-Entry-Principal': 'browser_b' });
  assert.equal(attack.status, 403);
  assert.deepEqual(await attack.json(), { code: 'FORBIDDEN', retryable: false, next_action: 'stop' });
  const broken = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, readReadiness: async () => { throw new Error(`do not expose ${result.join_url}`); } });
  const privateServer = createEntryServer(broken, { token });
  await new Promise(resolve => privateServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => privateServer.close(resolve)));
  const error = await fetch(`http://127.0.0.1:${privateServer.address().port}/entry`, { method: 'POST', headers, body: JSON.stringify(request('request_0001')) });
  assert.equal(error.status, 503);
  assert.deepEqual(await error.json(), { code: 'RUNTIME_UNAVAILABLE', retryable: true, next_action: 'wait' });
});

test('local negative evidence preserves the boundary reason but cannot promote a positive snapshot', async t => {
  const f = await setup(t);
  const positive = (await f.ports.readReadiness()).readiness;
  const local = value => createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, readReadiness: async () => ({
    mode: 'fixture', evidence_level: 'local_execution', readiness: value,
  }) });
  assert.equal((await local({ ...positive, credential_boundary_verified: false, entry_available: false, quoting_available: false, reason: 'credential_boundary_unverified' }).readiness()).reason, 'credential_boundary_unverified');
  await rejectsCode(local(positive).allocate('browser_a', request('request_0001')), 'RUNTIME_UNAVAILABLE');
  assert.equal((await f.adapter.allocate('browser_a', request('request_0001'))).room_id, f.rooms[0].room_id);
});

test('a contender observing a room newly occupied by another allocation moves to the next unused room', async t => {
  const f = await setup(t);
  let firstRead;
  const wait = new Promise(resolve => { firstRead = resolve; });
  let calls = 0;
  const ports = { ...f.ports, verifyRoom: async input => {
    if (input.room_id === f.rooms[0].room_id && ++calls === 1) await wait;
    const proof = await f.ports.verifyRoom(input);
    return { ...proof, unused: !f.db.prepare('SELECT 1 FROM entry_allocations WHERE room_id=?').get(input.room_id) };
  } };
  const slow = createEntryAdapter(f.db, f.config, { now: f.now, ...ports });
  const pending = slow.allocate('browser_b', request('request_b_0001'));
  const first = await f.adapter.allocate('browser_a', request('request_a_0001'));
  firstRead();
  const second = await pending;
  assert.notEqual(second.room_id, first.room_id);
  assert.deepEqual(await slow.allocate('browser_b', request('request_b_0001')), second);
});

test('server-only room binding preserves exact opaque link and refuses unknown, expired or unsafe rooms', async t => {
  const f = await setup(t);
  await rejectsCode(f.adapter.getRoomBinding(f.rooms[0].room_id), 'FORBIDDEN');
  const allocation = await f.adapter.allocate('browser_a', request('request_binding_01'));
  assert.deepEqual(await f.adapter.getRoomBinding(allocation.room_id), allocation);
  await rejectsCode(f.adapter.getRoomBinding('unknown_room'), 'FORBIDDEN');
  await rejectsCode(f.adapter.getRoomBinding('https://attacker.example'), 'INVALID_INPUT');
  const stopped = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, readReadiness: async () => {
    const source = await f.ports.readReadiness();
    source.readiness.credential_boundary_verified = false;
    return source;
  } });
  await rejectsCode(stopped.getRoomBinding(allocation.room_id), 'RUNTIME_UNAVAILABLE');
  const changed = createEntryAdapter(f.db, f.config, { now: f.now, ...f.ports, verifyRoom: async input => ({
    ...(await f.ports.verifyRoom(input)), join_url: f.rooms[1].join_url,
  }) });
  await rejectsCode(changed.getRoomBinding(allocation.room_id), 'RUNTIME_UNAVAILABLE');
  f.advance(600_001);
  await rejectsCode(f.adapter.getRoomBinding(allocation.room_id), 'RUNTIME_UNAVAILABLE');
});
