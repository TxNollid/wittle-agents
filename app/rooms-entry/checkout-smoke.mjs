// Real entry/payment factories and SQLite; ALL provider/membership observations are synthetic.
// This script requires the payment owner's trusted resolveRoomBinding repair; it never changes owner code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../whop-payments/server.mjs';
import { createEntryAdapter } from './index.mjs';
import { fixtureRooms, fixturePorts } from './fixtures.mjs';

const sources = ['index.mjs', '../whop-payments/v2.mjs', '../whop-payments/controller.mjs', '../whop-payments/server.mjs'];
const sourceHashes = () => Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]));
const before = sourceHashes();
const cases = JSON.parse(readFileSync(new URL('../contracts/valid.json', import.meta.url))).cases;
const offer = structuredClone(cases.find(row => row.definition === 'Offer').payload);
const root = await mkdtemp(join(tmpdir(), 'entry-checkout-smoke-'));
const clock = Date.parse('2026-10-24T18:00:00.000Z');
const now = () => clock;
const rooms = fixtureRooms(clock), ports = fixturePorts(rooms, { now });
const db = new DatabaseSync(join(root, 'entry.sqlite'));
let service;
const state = { allowed: true, entryAvailable: true, resolverPatch: null, resolverUnavailable: false, returnSuffix: '', creates: 0 };
const requests = new Map();
const admin = { id: 'operator', role: 'operator' };
try {
  const entry = createEntryAdapter(db, { enabled: true }, { now, ...ports, readReadiness: async () => {
    const source = await ports.readReadiness();
    if (!state.entryAvailable) source.readiness.entry_available = false;
    return source;
  } });
  entry.addRooms(rooms);
  const allocated = await entry.allocate('fixture_checkout_browser', { request_id: 'fixture_entry_checkout' });
  const client = {
    checkoutConfigurations: { async create(request, { idempotencyKey }) {
      state.creates++;
      if (!requests.has(idempotencyKey)) requests.set(idempotencyKey, {
        id: `ch_${idempotencyKey.replaceAll('-', '')}`,
        purchase_url: 'https://sandbox.whop.com/checkout/fixture-only/', request: structuredClone(request),
      });
      return requests.get(idempotencyKey);
    } },
    payments: { async retrieve() { throw new Error('No payment or provider call is part of this fixture composition'); } },
  };
  service = createService({
    WHOP_COMPANY_ID: offer.company_id, WHOP_PRODUCT_ID: 'prod_entry_fixture', WHOP_PLAN_ID: 'plan_entry_fixture',
    WHOP_PRICE: '19.00', APP_URL: 'http://127.0.0.1', PAYMENTS_SERVICE_TOKEN: 'synthetic-entry-checkout-only', PAYMENT_EVIDENCE_LEVEL: 'fixture',
  }, client, join(root, 'payment.sqlite'), { now, v2: {
    verifyCapability: async authority => state.allowed && authority === 'fixture-entry-authority' ? {
      capability_id: 'fixture_entry_cap', buyer_id: offer.buyer_id, room_id: allocated.room_id, agent_id: 'fixture_host', job_id: null,
      operations: ['quote', 'order_status'], membership_id: 'fixture_membership', source_event_id: 'fixture_buyer_event',
      issued_at: new Date(clock).toISOString(), verified_at: new Date(clock).toISOString(), expires_at: new Date(clock + 60_000).toISOString(), revoked_at: null,
    } : null,
    getTerms: async () => ({ service_id: offer.service_id, scope: structuredClone(offer.scope),
      expires_at: new Date(clock + 300_000).toISOString(), return_url: allocated.join_url + state.returnSuffix }),
    resolveRoomBinding: async cap => {
      if (state.resolverUnavailable) return null;
      const binding = await entry.getRoomBinding(cap.room_id);
      return { ...binding, ...state.resolverPatch };
    },
  } });
  const c = service.controller;
  c.register(admin, { id: offer.buyer_id, role: 'buyer', kind: 'agent' });
  c.register(admin, { id: offer.seller_id, role: 'seller', kind: 'agent' });
  c.setService(admin, {
    id: offer.service_id, seller_id: offer.seller_id, service_version: offer.service_version, prompt_version: 'auditor-v1',
    amount_minor: offer.amount_minor, currency: 'usd', account_id: offer.company_id,
    product_id: 'prod_entry_fixture', plan_id: 'plan_entry_fixture', execution_cap_minor: 500, allowed_actions: offer.scope.allowed_actions,
  });
  const input = { site_url: offer.scope.site_url, scope_summary: offer.scope.scope_summary, pages: offer.scope.pages,
    findings_cap: offer.scope.findings_cap, request_id: 'fixture_checkout_quote' };
  const quote = () => service.v2.quote('fixture-entry-authority', input);
  const first = await quote();
  assert.equal(first.offer.room_id, allocated.room_id);
  assert.equal(first.mode, 'fixture');
  const order = service.db.prepare('SELECT * FROM orders WHERE quote_id=?').get(first.quote_id);
  assert.equal(requests.get(order.id).request.redirect_url, allocated.join_url);
  assert.deepEqual(await quote(), first);
  assert.equal(state.creates, 1);

  let denied = 0;
  const mustDeny = async operation => {
    const count = state.creates;
    await assert.rejects(operation);
    assert.equal(state.creates, count, 'Denied binding must not reach checkout provider');
    denied++;
  };
  // Both existing-quote retry and new initial offers must honor current canonical binding.
  for (const patch of [
    { room_id: 'wrong_fixture_room' }, { mode: 'sandbox' },
    { expires_at: new Date(clock - 1).toISOString() },
    { join_url: allocated.join_url + '&altered_same_origin=1' },
  ]) {
    state.resolverPatch = patch;
    await mustDeny(quote);
    await mustDeny(() => service.v2.quote('fixture-entry-authority', { ...input, request_id: `fixture_deny_${denied}` }));
  }
  state.resolverPatch = null;
  state.resolverUnavailable = true;
  await mustDeny(quote);
  state.resolverUnavailable = false;
  state.entryAvailable = false;
  await mustDeny(quote);
  state.entryAvailable = true;
  state.returnSuffix = '&untrusted_terms_override=1';
  await mustDeny(() => service.v2.quote('fixture-entry-authority', { ...input, request_id: 'fixture_changed_terms' }));
  state.returnSuffix = '';
  state.allowed = false;
  await mustDeny(quote);
  state.allowed = true;
  assert.deepEqual(await quote(), first);
  assert.equal(state.creates, 1);
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
  assert.deepEqual(sourceHashes(), before, 'Consumer candidate changed during smoke');
  console.log(JSON.stringify({
    evidence_level: 'local_execution', mode: 'fixture', provider_or_customer_proof: false,
    checks: { exact_opaque_initial_and_retry: 'PASS', one_checkout: 'PASS', wrong_room_mode_expiry_and_link: 'PASS',
      unavailable_current_entry: 'PASS', changed_terms: 'PASS', independent_membership: 'PASS', no_human_approval_impersonation: 'PASS' },
    denied_operations: denied, source_sha256: before,
  }, null, 2));
} finally {
  service?.close(); db.close(); await rm(root, { recursive: true, force: true });
}
