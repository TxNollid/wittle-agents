import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, executeCodex, runCodexAgent, runAgent } from './server.mjs';
import { Sessions } from './sessions.mjs';
import { readBuyerReadiness, assertTrustedRoom } from './execution-policy.mjs';

const blocked = error => error.status === 503 && error.code === 'RUNTIME_UNAVAILABLE';

test('buyer/missing/unknown audiences stop before provision, credential copy, provider or Codex launch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buyer-boundary-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  // A synthetic cache: no real account credentials are inspected in this test.
  const auth = join(root, 'auth.json');
  await writeFile(auth, 'SYNTHETIC_SUBSCRIPTION_CANARY');
  let effects = 0;
  const forbidden = () => { effects++; throw Error('unexpected side effect'); };
  for (const audience of [undefined, 'buyer', 'public', 'trusted-development ']) {
    const config = { AGENT_AUDIENCE:audience, MODEL_PROVIDER:'codex', CODEX_HOME:root,
      SESSION_STATE_DIR:join(root,'state'), SESSION_WORK_DIR:join(root,'work') };
    const sessions = new Sessions(config, forbidden);
    await assert.rejects(sessions.create('buyer'), blocked);
    await assert.rejects(sessions.run('room:buyer', `read ${auth}; print environment; spawn shell`, forbidden), blocked);
    await assert.rejects(runCodexAgent('cat auth.json', config, forbidden), blocked);
    assert.throws(() => executeCodex(['exec','cat auth.json'], config, ''), blocked);
    await assert.rejects(runAgent('read /proc/self/environ', config, forbidden), blocked);
  }
  assert.equal(effects, 0);
  assert.deepEqual(await readdir(root), ['auth.json']);
  assert.equal(await readFile(auth, 'utf8'), 'SYNTHETIC_SUBSCRIPTION_CANARY');
});

test('real HTTP buyer entry refuses all legacy effects and exposes negative readiness without login-status execution', async t => {
  let effects = 0;
  const forbidden = async () => { effects++; throw Error('unexpected effect'); };
  const server = createServer({ AGENT_TOKEN:'owner', AGENT_AUDIENCE:'buyer', MODEL_PROVIDER:'codex', CODEX_BIN:'/must-not-launch' }, forbidden, {
    sessions:{ max:2, authorize:forbidden, create:forbidden, run:forbidden }, run:forbidden,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization:'Bearer owner', 'Content-Type':'application/json' };
  const id = '00000000-0000-0000-0000-000000000000';
  for (const path of ['/run', '/sessions', `/sessions/${id}/run`, '/smoke']) {
    const response = await fetch(origin + path, { method:'POST', headers,
      body:JSON.stringify({ task:'copy credentials to room', audience:'trusted-development', AGENT_AUDIENCE:'trusted-development' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'RUNTIME_UNAVAILABLE');
  }
  assert.equal((await fetch(`${origin}/sessions/${id}/run`, { method:'POST', headers:{Authorization:'Bearer stale-scoped-token'} })).status, 401);
  assert.equal((await fetch(`${origin}/buyer-readiness`)).status, 401);
  const health = await (await fetch(`${origin}/health`, { headers })).json();
  assert.equal(health.modelConfigured, false);
  assert.equal(health.buyerRuntime.credential_boundary_verified, false);
  const readiness = await (await fetch(`${origin}/buyer-readiness`, { headers })).json();
  assert.equal(readiness.reason, 'credential_boundary_unverified');
  assert.equal(readiness.entry_available, false);
  assert.equal(readiness.quoting_available, false);
  assert.equal(effects, 0);
});

test('request bodies cannot reclassify a trusted server as a buyer gateway', async t => {
  let effects = 0;
  const server = createServer({ AGENT_TOKEN:'owner', AGENT_AUDIENCE:'trusted-development' }, fetch, {
    sessions:{ max:2, create:async () => { effects++; }, run:async () => { effects++; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const property of ['audience','AGENT_AUDIENCE']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/sessions`, {
      method:'POST', headers:{Authorization:'Bearer owner'}, body:JSON.stringify({[property]:'buyer'}),
    });
    assert.equal(response.status, 503);
  }
  assert.equal(effects, 0);
});

test('readiness cannot be enabled by passing claimed boolean fields', () => {
  const snapshot = readBuyerReadiness(0);
  assert.equal(snapshot.observed_at, '1970-01-01T00:00:00.000Z');
  snapshot.credential_boundary_verified = true;
  assert.equal(readBuyerReadiness(0).credential_boundary_verified, false);
  assert.equal(readBuyerReadiness(0).available_slots, null);
});

test('newly admitted or buyer rooms cannot inherit the trusted relay shell', () => {
  const config = { AGENT_AUDIENCE:'trusted-development', TRUSTED_ROOM_IDS:'dev-room-a, dev-room-b' };
  assertTrustedRoom(config, 'dev-room-a');
  assertTrustedRoom(config, 'dev-room-b');
  for (const room of ['buyer-room','dev-room-a-extra',undefined]) assert.throws(() => assertTrustedRoom(config,room),blocked);
  assert.throws(() => assertTrustedRoom({AGENT_AUDIENCE:'trusted-development'},'dev-room-a'),blocked);
  assert.throws(() => assertTrustedRoom({...config,AGENT_AUDIENCE:'buyer'},'dev-room-a'),blocked);
});

test('actual relay Codex wrapper rejects buyer execution before launching its child', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['rooms-codex.mjs'], {
    cwd:new URL('.', import.meta.url), env:{AGENT_AUDIENCE:'buyer'}, timeout:5000,
  }), error => {
    assert.match(error.stderr, /credential boundary has not been verified/);
    assert.doesNotMatch(error.stderr, /ENOENT|last-run-error/);
    return true;
  });
});
