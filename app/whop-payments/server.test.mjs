import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from './server.mjs';
const config = { WHOP_COMPANY_ID: 'biz_test', WHOP_PRODUCT_ID: 'prod_test', WHOP_PLAN_ID: 'plan_test', WHOP_PRICE: '10.00', WHOP_WEBHOOK_SECRET: 'ws_testing', PAYMENTS_SERVICE_TOKEN: 'private-test-token', APP_URL: 'http://localhost:3210' };
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'whop-payments-'));
  let payment;
  let calls = 0;
  const client = { checkoutConfigurations: { async create() { calls++; return { id: 'ch_test', purchase_url: 'https://sandbox.whop.com/checkout/ch_test/' }; } }, payments: { async retrieve() { return payment; } } };
  const path = join(directory, 'db.sqlite');
  const service = createService(config, client, path);
  await new Promise(r => service.server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + service.server.address().port;
  t.after(async () => { await new Promise(r => service.server.close(r)); service.close(); rmSync(directory, { recursive: true }); });
  const order = await service.checkout('buyer', 'request-12345');
  payment = { id: 'pay_test', account_id: 'biz_test', product_id: 'prod_test', plan_id: 'plan_test', checkout_configuration_id: 'ch_test', metadata: { order_id: order.id, environment: 'sandbox' }, currency: 'usd', subtotal: { amount: '10.00', currency: 'usd' }, total: { amount: '10.00', currency: 'usd' }, status: 'paid', substatus: 'succeeded' };
  return { ...service, order, payment, url, path, client, calls: () => calls };
}
test('checkout retry reuses the saved checkout; private routes require authentication', async t => {
  const f = await fixture(t);
  assert.equal((await f.checkout('buyer', 'request-12345')).id, f.order.id);
  assert.equal(f.calls(), 1);
  assert.equal((await fetch(f.url + '/api/checkout', { method: 'POST', body: '{}' })).status, 401);
});
test('rejects mismatched account, amount, order, checkout and refunded payments', async t => {
  const f = await fixture(t);
  for (const [key, value] of Object.entries({ account_id: 'biz_other', plan_id: 'plan_other', checkout_configuration_id: 'ch_other', subtotal: { amount: '1.00', currency: 'usd' }, refunded_at: '2026-10-24' })) {
    const old = f.payment[key]; f.payment[key] = value;
    await assert.rejects(f.reconcile('pay_test'), { status: 422 }); f.payment[key] = old;
  }
  await assert.rejects(f.reconcile('pay_test', 'wrong-order'), { status: 422 });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fulfillments').get().n, 0);
});
test('pending payment does not fulfill; confirmed payment fulfills once across replays and restart', async t => {
  const f = await fixture(t);
  f.payment.status = 'pending'; await f.reconcile('pay_test');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fulfillments').get().n, 0);
  f.payment.status = 'paid'; await f.reconcile('pay_test'); await f.reconcile('pay_test');
  const reopened = createService(config, f.client, f.path);
  await reopened.reconcile('pay_test');
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM fulfillments').get().n, 1);
  reopened.close();
});
test('webhook rejects unsigned, tampered and stale payloads; signed duplicates persist once', async t => {
  const f = await fixture(t);
  const event = { id: 'msg_test', account_id: 'biz_test', type: 'payment.succeeded', data: f.payment };
  const raw = JSON.stringify(event), now = Math.floor(Date.now() / 1000);
  const headers = timestamp => ({ 'Content-Type': 'application/json', 'webhook-id': event.id, 'webhook-timestamp': String(timestamp), 'webhook-signature': 'v1,' + createHmac('sha256', config.WHOP_WEBHOOK_SECRET).update(event.id + '.' + timestamp + '.' + raw).digest('base64') });
  const post = (body, h) => fetch(f.url + '/api/webhooks/whop', { method: 'POST', headers: h, body });
  assert.equal((await post(raw, {})).status, 401);
  assert.equal((await post(raw + ' ', headers(now))).status, 401);
  assert.equal((await post(raw, headers(now - 600))).status, 401);
  assert.equal((await post(raw, headers(now))).status, 200);
  assert.equal((await post(raw, headers(now))).status, 200);
  await f.drain();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fulfillments').get().n, 1);
});
