// Actual loopback HTTP + durable SQLite; all successful allocations below are FIXTURES.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntryAdapter } from './index.mjs';
import { createEntryServer } from './server.mjs';
import { fixtureRooms, fixturePorts } from './fixtures.mjs';
import { validateJoinResponse } from '../web/lib/entry.mjs';
import { readBuyerReadiness } from '../solari-agent/execution-policy.mjs';

const root = await mkdtemp(join(tmpdir(), 'entry-smoke-'));
const token = 'synthetic-server-token-for-loopback-smoke-only';
let db, server;
const listen = async adapter => {
  server = createEntryServer(adapter, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const stop = async () => { if (server) { await new Promise(resolve => server.close(resolve)); server = null; } if (db) { db.close(); db = null; } };
const post = (base, principal, request_id) => fetch(`${base}/entry`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Wittle-Entry-Principal': principal },
  body: JSON.stringify({ request_id }),
});
try {
  const path = join(root, 'fixture.sqlite');
  const rooms = fixtureRooms();
  const ports = fixturePorts(rooms);
  db = new DatabaseSync(path);
  const adapter = createEntryAdapter(db, { enabled: true }, ports);
  adapter.addRooms(rooms);
  let base = await listen(adapter);
  assert.equal((await fetch(`${base}/entry`, { headers: { Purpose: 'prefetch' } })).status, 405);
  const responses = await Promise.all([post(base, 'fixture_browser_a', 'fixture_request_a'), post(base, 'fixture_browser_b', 'fixture_request_b')]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const [a, b] = await Promise.all(responses.map(response => response.json()));
  assert.notEqual(a.room_id, b.room_id);
  assert.equal(a.mode, 'fixture');
  assert.equal(validateJoinResponse(a, 'fixture'), a.join_url);
  assert.equal(validateJoinResponse(b, 'fixture'), b.join_url);
  assert.deepEqual(await adapter.getRoomBinding(a.room_id), a);
  await assert.rejects(adapter.getRoomBinding('unallocated_fixture_room'), error => error.code === 'FORBIDDEN');
  const replay = await post(base, 'fixture_browser_a', 'fixture_request_a');
  assert.deepEqual(await replay.json(), a);
  assert.equal((await post(base, 'fixture_browser_c', 'fixture_request_a')).status, 403);
  assert.equal((await post(base, 'fixture_browser_c', 'fixture_request_c')).status, 200);
  const exhausted = await post(base, 'fixture_browser_d', 'fixture_request_d');
  assert.equal(exhausted.status, 503);
  assert.deepEqual(await exhausted.json(), { code: 'RUNTIME_UNAVAILABLE', retryable: true, next_action: 'wait' });
  await stop();

  db = new DatabaseSync(path);
  base = await listen(createEntryAdapter(db, { enabled: true }, ports));
  assert.deepEqual(await (await post(base, 'fixture_browser_a', 'fixture_request_a')).json(), a);
  await stop();

  // Actual free-only HTTP entry without any paid terms, using explicit synthetic proofs.
  const freePath = join(root, 'fixture-free.sqlite');
  const unpaidPorts = { ...ports, readReadiness: async () => {
    const source = await ports.readReadiness();
    return { ...source, readiness: { ...source.readiness, quoting_available: false, reason: 'terms_unavailable' } };
  } };
  db = new DatabaseSync(freePath);
  const free = createEntryAdapter(db, { enabled: true, purpose: 'free_scoping' }, unpaidPorts);
  free.addRooms(rooms);
  base = await listen(free);
  const freeHealth = await fetch(`${base}/readiness`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(freeHealth.status, 200);
  const freeReady = await freeHealth.json();
  assert.equal(freeReady.entry_available, true);
  assert.equal(freeReady.quoting_available, false);
  const freeEntry = await post(base, 'fixture_free_browser', 'fixture_free_request');
  assert.equal(freeEntry.status, 200);
  const freeBinding = await freeEntry.json();
  assert.equal(validateJoinResponse(freeBinding, 'fixture'), rooms[0].join_url);
  await stop();
  db = new DatabaseSync(freePath);
  base = await listen(createEntryAdapter(db, { enabled: true }, unpaidPorts));
  assert.equal((await post(base, 'fixture_free_browser', 'fixture_free_request')).status, 503);
  const override = await fetch(`${base}/entry`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Wittle-Entry-Principal': 'fixture_free_browser' },
    body: JSON.stringify({ request_id: 'fixture_free_request', purpose: 'free_scoping' }),
  });
  assert.equal(override.status, 400);
  await stop();

  // Consume the Solari owner's actual negative seam: local evidence cannot open buyer entry.
  db = new DatabaseSync(join(root, 'sandbox-closed.sqlite'));
  let roomReads = 0;
  const closed = createEntryAdapter(db, { enabled: true, mode: 'sandbox', purpose: 'free_scoping' }, {
    readReadiness: async () => ({ mode: 'sandbox', evidence_level: 'local_execution', readiness: readBuyerReadiness() }),
    verifyRoom: async () => { roomReads++; throw new Error('This port must not run while boundary is unverified'); },
  });
  base = await listen(closed);
  const health = await fetch(`${base}/readiness`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(health.status, 503);
  assert.equal((await health.json()).reason, 'credential_boundary_unverified');
  assert.equal((await post(base, 'fixture_browser_a', 'fixture_request_a')).status, 503);
  assert.equal(roomReads, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entry_allocations').get().n, 0);
  console.log(JSON.stringify({
    evidence_level: 'local_execution', successful_allocation_mode: 'fixture',
    checks: {
      distinct_private_allocations: 'PASS', stable_retry: 'PASS', cross_browser_replay: 'PASS',
      exhaustion: 'PASS', prefetch_no_allocation: 'PASS', sqlite_reopen: 'PASS',
      web_response_validation: 'PASS', actual_solari_negative_readiness: 'PASS',
      trusted_exact_room_binding: 'PASS',
      free_scoping_without_paid_terms: 'PASS', free_never_grants_quoting: 'PASS',
      default_paid_terms_still_required: 'PASS', browser_purpose_override_denied: 'PASS',
    },
    provider_or_customer_proof: false,
  }, null, 2));
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
