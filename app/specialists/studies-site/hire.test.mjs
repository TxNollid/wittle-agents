import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentMatches, planFor, SERVICES, scopeHash } from './lib/hire.mjs';

const row = { order_id: 'o1', room_id: 'roomroom01', service_id: 'anti_slop_v1', scope_hash: scopeHash('rewrite my post'), environment: 'sandbox', checkout_id: 'ch_1' };
const svc = SERVICES.anti_slop_v1;
const good = { id: 'pay_1', status: 'paid', substatus: 'succeeded', refunded_at: null, checkout_configuration_id: 'ch_1',
  metadata: { order_id: 'o1', room_id: 'roomroom01', service_id: 'anti_slop_v1', scope_hash: row.scope_hash, environment: 'sandbox' },
  total: { amount: '9.00', currency: 'usd' } };

test('payment must match the full order tuple', () => {
  assert.ok(paymentMatches(good, row, svc));
  for (const [k, v] of [['checkout_configuration_id', 'ch_2'], ['status', 'pending']]) assert.ok(!paymentMatches({ ...good, [k]: v }, row, svc), k);
  for (const k of ['order_id', 'room_id', 'service_id', 'scope_hash', 'environment']) {
    assert.ok(!paymentMatches({ ...good, metadata: { ...good.metadata, [k]: 'x' } }, row, svc), k);
  }
  assert.ok(!paymentMatches({ ...good, total: { amount: '8.99', currency: 'usd' } }, row, svc), 'underpaid');
  assert.ok(!paymentMatches({ ...good, total: { amount: '9.00', currency: 'eur' } }, row, svc), 'currency');
  assert.ok(!paymentMatches(null, row, svc));
});

test('refunds and disputes revoke payment', () => {
  assert.ok(!paymentMatches({ ...good, refunded_at: '2026-10-24T22:00:00Z' }, row, svc));
  for (const s of ['refunded', 'partially_refunded', 'dispute_needs_response', 'dispute_lost']) assert.ok(!paymentMatches({ ...good, substatus: s }, row, svc), s);
  assert.ok(paymentMatches({ ...good, substatus: 'dispute_won' }, row, svc));
});

test('plan ids come from env per service', () => {
  assert.equal(planFor('anti_slop_v1', { WHOP_PLAN_ANTI_SLOP_V1: 'plan_x' }), 'plan_x');
  assert.equal(planFor('local_guide_nyc_v1', {}), null);
});
