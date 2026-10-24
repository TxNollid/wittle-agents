import test from 'node:test';
import assert from 'node:assert/strict';
import { antiSlopLayout, normalizeResponse } from './study-core.mjs';
import v1 from './data/anti-slop-v1.json' with { type: 'json' };
import handler from './api/response.mjs';

const ids = v1.pairs.map((p) => p.id);
const byWave = { v1: ids, v2: ids };

test('layout is stable per participant and covers every pair', () => {
  const a = antiSlopLayout(ids, 'sub1:v1');
  assert.deepEqual(a, antiSlopLayout(ids, 'sub1:v1'));
  assert.deepEqual([...a.map((x) => x.pair_id)].sort(), [...ids].sort());
  const sides = new Set(Array.from({ length: 20 }, (_, i) => antiSlopLayout(ids, `s${i}:v1`)[0].rewrite_side));
  assert.deepEqual([...sides].sort(), ['A', 'B']);
});

function body(sub = 'sub_1', choiceFor = (slot) => slot.rewrite_side) {
  const layout = antiSlopLayout(ids, `${sub}:v1`);
  return { study: 'anti-slop', wave: 'v1', terac_submission_id: sub, terac_task_id: 'task_9',
    answers: layout.map((s) => ({ pair_id: s.pair_id, choice: choiceFor(s), why: '' })), note: 'too many buzzwords' };
}

test('anti-slop response records whether the rewrite was picked', () => {
  const row = normalizeResponse(body(), byWave);
  assert.equal(row.answers.length, 5);
  assert.ok(row.answers.every((a) => a.picked_rewrite));
  const flipped = normalizeResponse(body('sub_1', (s) => (s.rewrite_side === 'A' ? 'B' : 'A')), byWave);
  assert.ok(flipped.answers.every((a) => !a.picked_rewrite));
});

test('anti-slop response rejects tampering and missing ids', () => {
  const b = body();
  b.answers.reverse();
  assert.throws(() => normalizeResponse(b, byWave), /order mismatch/);
  assert.throws(() => normalizeResponse({ ...body(), terac_submission_id: '' }, byWave), /submission id/);
  assert.throws(() => normalizeResponse({ ...body(), note: ' ' }, byWave), /missing text/);
  assert.throws(() => normalizeResponse({ ...body(), wave: 'v9' }, byWave), /unknown wave/);
});

test('local guide response validates the scale', () => {
  const ok = normalizeResponse({ study: 'local-guide', wave: 'v1', terac_submission_id: 's2', would_go: 6, problems: 'nothing' });
  assert.equal(ok.answers.would_go, 6);
  assert.throws(() => normalizeResponse({ study: 'local-guide', wave: 'v1', terac_submission_id: 's2', would_go: 9, problems: 'x' }), /1-7/);
});

const req = (method, payload, headers = {}) => new Request('https://studies.example.com/api/response', {
  method, headers: { origin: 'https://studies.example.com', 'content-type': 'application/json', ...headers },
  body: payload ? JSON.stringify(payload) : undefined,
});

test('api refuses cross-origin, closed wave v2, and reports missing storage honestly', async () => {
  delete process.env.DATABASE_URL;
  assert.equal((await handler.fetch(req('POST', body(), { origin: 'https://evil.example' }))).status, 403);
  const v2 = { ...body(), wave: 'v2' };
  v2.answers = antiSlopLayout(ids, 'sub_1:v2').map((s) => ({ pair_id: s.pair_id, choice: 'A' }));
  assert.equal((await handler.fetch(req('POST', v2))).status, 409);
  const res = await handler.fetch(req('POST', body()));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).saved, false);
  assert.equal((await handler.fetch(new Request('https://studies.example.com/api/response'))).status, 401);
});
