import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelivery } from './delivery.mjs';
import { runAudit } from './audit.mjs';
import { fixtureJob } from './fixtures.mjs';
const adapter = { evidence_kind: 'fixture', async observe({ url, viewport }) { return { url, viewport, facts: { issues: [] } }; } };

test('persisted unsent result resumes after restart without rerunning audit; changed buyer or scope is rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wittle-result-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let permitSend = false;
  let sends = 0;
  const options = { databasePath: join(dir, 'result.sqlite'),
    authorize: async ({ job, operation }) => ({ ...job, allowed: operation !== 'deliver' || permitSend }),
    send: async ({ room_id, delivery_key }) => ({ room_id, delivery_key, message_id: `m-${++sends}` }), readBuyerEvent: async () => null };
  let store = createDelivery(options);
  const job = fixtureJob();
  await assert.rejects(store.fulfill(job, current => runAudit(current, adapter)), /PAID_JOB_NOT_AUTHORIZED/);
  assert.equal(store.inspect(job.order_id).reports[0].phase, 'saved');
  store.close();
  store = createDelivery(options);
  t.after(() => store.close());
  permitSend = true;
  await assert.rejects(store.deliver({ ...job, buyer_id: 'different-buyer' }), /ORDER_BINDING_MISMATCH/);
  await assert.rejects(store.deliver({ ...job, scope: { ...job.scope, goal: 'Different scope with unchanged quote hash' } }), /ORDER_BINDING_MISMATCH/);
  assert.equal((await store.fulfill(job, () => { throw Error('Saved result must survive'); })).state, 'delivered');
  assert.equal(sends, 1);
  const records = store.records(job.order_id);
  assert.equal(records.result.report.artifact_id, records.delivery.artifact_id);
  assert.match(records.result.report.sha256, /^[0-9a-f]{64}$/);
});
test('partial reports remain durable but never create a completed delivery or completed result event', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wittle-partial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let sends = 0;
  const store = createDelivery({ databasePath: join(dir, 'result.sqlite'),
    authorize: async ({ job }) => ({ ...job, allowed: true }), send: async () => { sends++; }, readBuyerEvent: async () => null });
  t.after(() => store.close());
  const job = fixtureJob();
  const outcome = await store.fulfill(job, current => runAudit(current, adapter, { maxObservations: 1 }));
  assert.equal(outcome.state, 'needs_attention');
  assert.equal(sends, 0);
  assert.equal(JSON.parse(store.inspect(job.order_id).reports[0].payload).state, 'partial');
  assert.deepEqual(store.records(job.order_id), { result: null, delivery: null });
  await assert.rejects(store.reconcile(job, { receipt: { room_id: job.room_id, delivery_key: outcome.delivery_key, message_id: 'invented' } }), /RECONCILIATION_MISMATCH/);
});
