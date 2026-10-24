import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelivery } from './delivery.mjs';
import { runAudit } from './audit.mjs';
import { fixtureJob } from './fixtures.mjs';

const adapter = { evidence_kind: 'fixture', async observe({ url, viewport }) { return { url, viewport, facts: { issues: [] } }; } };
const run = job => runAudit(job, adapter);
async function setup(t, { uncertain = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wittle-auditor-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { allowed: true, sends: 0, events: {} };
  const options = { databasePath: join(dir, 'results.sqlite'),
    authorize: async ({ job }) => ({ ...job, allowed: state.allowed }),
    send: async ({ room_id, delivery_key }) => {
      state.sends++;
      if (uncertain) throw new Error('Lost acknowledgement');
      return { room_id, delivery_key, message_id: `message-${state.sends}` };
    }, readBuyerEvent: async id => state.events[id] };
  const store = createDelivery(options);
  t.after(() => { try { store.close(); } catch {} });
  return { store, options, state };
}
test('saved delivery survives restart; silence and retries never duplicate a completed send', async t => {
  const { store, options, state } = await setup(t);
  const job = fixtureJob();
  assert.equal((await store.fulfill(job, run)).state, 'delivered');
  store.close();
  const restarted = createDelivery(options);
  t.after(() => restarted.close());
  assert.equal((await restarted.fulfill(job, () => { throw Error('Must reuse saved result'); })).duplicate, true);
  assert.equal(state.sends, 1);
  assert.equal(restarted.inspect(job.order_id).reports[0].phase, 'delivered');
  assert.equal(restarted.inspect(job.order_id).rating, null);
  state.allowed = false;
  await assert.rejects(restarted.deliver(job), /PAID_JOB_NOT_AUTHORIZED/);
});
test('unknown send outcome pauses across restarts until a bound operator receipt reconciles', async t => {
  const { store, options, state } = await setup(t, { uncertain: true });
  const job = fixtureJob();
  const first = await store.fulfill(job, run);
  assert.equal(first.state, 'needs_attention');
  store.close();
  const restarted = createDelivery(options);
  t.after(() => restarted.close());
  assert.equal((await restarted.deliver(job)).reason, 'OPERATOR_RECONCILIATION_REQUIRED');
  assert.equal(state.sends, 1);
  await assert.rejects(restarted.reconcile(job, { receipt: { room_id: 'wrong-room', delivery_key: first.delivery_key, message_id: 'recovered' } }), /RECONCILIATION_MISMATCH/);
  await restarted.reconcile(job, { receipt: { room_id: job.room_id, delivery_key: first.delivery_key, message_id: 'recovered' } });
  assert.equal((await restarted.deliver(job)).duplicate, true);
  assert.equal(state.sends, 1);
});
test('revision limit persists and ratings require current bound buyer evidence after delivery', async t => {
  const { store, state } = await setup(t);
  const job = fixtureJob();
  await assert.rejects(store.rate(job, 'rating'), /RATING_BEFORE_DELIVERY/);
  await store.fulfill(job, run);
  state.events.wrong = { id: 'wrong', room_id: 'other-room', actor_id: job.buyer_id, position: 3 };
  await assert.rejects(store.rate(job, 'wrong'), /BUYER_EVENT_NOT_ATTRIBUTABLE/);
  state.events.forged = { id: 'forged', room_id: job.room_id, actor_id: 'auditor', position: 3 };
  await assert.rejects(store.rate(job, 'forged'), /BUYER_EVENT_NOT_ATTRIBUTABLE/);
  state.events.rating = { id: 'rating', room_id: job.room_id, actor_id: job.buyer_id, position: 4, type: 'rating', value: 4, after_message_id: 'message-1' };
  assert.equal((await store.rate(job, 'rating')).updated, true);
  assert.equal((await store.rate(job, 'rating')).updated, false);
  state.events.earlier = { ...state.events.rating, id: 'earlier', position: 3, value: 1 };
  assert.equal((await store.rate(job, 'earlier')).rating, 4);
  state.events.revision = { id: 'revision', room_id: job.room_id, actor_id: job.buyer_id, position: 5, type: 'revision', pages: job.scope.pages, instructions: 'Clarify the mobile findings', in_scope: true };
  await assert.rejects(store.revise(job, { event_id: 'revision', pages: ['https://example.com/extra'], instructions: 'Clarify the mobile findings' }, run), /REVISION_EVENT_MISMATCH/);
  const request = { event_id: 'revision', pages: job.scope.pages, instructions: 'Clarify the mobile findings' };
  assert.equal((await store.revise(job, request, run)).state, 'revised');
  await assert.rejects(store.revise(job, request, run), /REVISION_ALREADY_USED/);
  assert.equal(state.sends, 2);
  assert.equal((await store.deliver(job, 1)).state, 'revised');
  assert.equal((await store.rate(job, 'rating')).state, 'revised');
});
test('revocation before result persistence saves and sends nothing; cross-room job cannot use saved results', async t => {
  const { store, state } = await setup(t);
  const job = fixtureJob();
  await assert.rejects(store.fulfill(job, async current => { const report = await run(current); state.allowed = false; return report; }), /PAID_JOB_NOT_AUTHORIZED/);
  assert.equal(store.inspect(job.order_id), null);
  assert.equal(state.sends, 0);
  state.allowed = true;
  await store.fulfill(job, run);
  await assert.rejects(store.deliver({ ...job, room_id: 'another-room' }), /ORDER_BINDING_MISMATCH/);
});
