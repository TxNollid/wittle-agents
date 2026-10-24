// Hosted-agent hiring: a pool of agent-opened rooms (strangers join by link) and one
// Whop checkout per room. Paid status comes only from Whop, never from room text.
import { createHash, randomUUID } from 'node:crypto';
import { database, queryOptions } from './db.mjs';

export const SERVICES = {
  anti_slop_v1: { agent: '@hostedagents.anti-slop-editor', title: 'Anti-Slop Editor', price_usd: 9 },
  local_guide_nyc_v1: { agent: '@hostedagents.local-guide-nyc', title: 'Local Guide NYC', price_usd: 15 },
  website_audit_v1: { agent: '@hostedagents.website-auditor', title: 'Website Auditor', price_usd: 19 },
};

const ROOM = /^[A-Za-z0-9_-]{10,40}$/;
const JOIN = /^https:\/\/rooms\.wittlelabs\.ai\/j\/[A-Za-z0-9_-]{10,80}$/;
const REQUEST = /^[A-Za-z0-9_-]{8,80}$/;
export const isRoomId = (v) => typeof v === 'string' && ROOM.test(v);
export const isRequestId = (v) => typeof v === 'string' && REQUEST.test(v);
export const planFor = (service_id, env = process.env) => env[`WHOP_PLAN_${service_id.toUpperCase()}`] || null;

const schemas = [
  `CREATE TABLE IF NOT EXISTS hire_rooms (
    room_id text PRIMARY KEY,
    service_id text NOT NULL,
    join_url text NOT NULL,
    order_id text NOT NULL UNIQUE,
    claimed_at timestamptz,
    checkout_id text,
    checkout_url text,
    payment_id text,
    paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'ALTER TABLE hire_rooms ADD COLUMN IF NOT EXISTS request_id text UNIQUE',
  'ALTER TABLE hire_rooms ADD COLUMN IF NOT EXISTS scope text',
  'ALTER TABLE hire_rooms ADD COLUMN IF NOT EXISTS scope_hash text',
  'ALTER TABLE hire_rooms ADD COLUMN IF NOT EXISTS plan_id text',
  'ALTER TABLE hire_rooms ADD COLUMN IF NOT EXISTS environment text',
  'ALTER TABLE hire_rooms ADD COLUMN IF NOT EXISTS revoked_reason text',
];
let ready;
async function db() {
  const d = await database();
  ready ||= (async () => { for (const s of schemas) await d.query(s, [], queryOptions()); })().catch((e) => { ready = undefined; throw e; });
  await ready;
  return d;
}

export async function addRooms(rooms) {
  const d = await db();
  let added = 0;
  for (const r of rooms) {
    if (!SERVICES[r.service_id] || !isRoomId(r.room_id) || !JOIN.test(r.join_url)) throw new Error('bad room');
    const res = await d.query(
      'INSERT INTO hire_rooms (room_id, service_id, join_url, order_id) VALUES ($1, $2, $3, $4) ON CONFLICT (room_id) DO NOTHING RETURNING room_id',
      [r.room_id, r.service_id, r.join_url, randomUUID()], queryOptions());
    added += res.length;
  }
  return added;
}

// Deliberate, idempotent allocation: the same request_id always gets the same room.
export async function claimRoom(service_id, request_id) {
  if (!SERVICES[service_id]) throw new Error('unknown service');
  if (!isRequestId(request_id)) throw new Error('bad request_id');
  const d = await db();
  const [existing] = await d.query('SELECT room_id, join_url, service_id FROM hire_rooms WHERE request_id = $1', [request_id], queryOptions());
  if (existing) {
    if (existing.service_id !== service_id) throw new Error('bad request_id reused for another service');
    return existing;
  }
  const rows = await d.query(
    `UPDATE hire_rooms SET claimed_at = now(), request_id = $2 WHERE room_id = (
       SELECT room_id FROM hire_rooms WHERE service_id = $1 AND claimed_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING room_id, join_url`, [service_id, request_id], queryOptions());
  return rows[0] || null;
}

export async function poolCounts() {
  const d = await db();
  return d.query('SELECT service_id, count(*) FILTER (WHERE claimed_at IS NULL)::int AS free, count(*)::int AS total FROM hire_rooms GROUP BY service_id', [], queryOptions());
}

export const scopeHash = (scope) => createHash('sha256').update(scope).digest('hex');

// A Whop payment counts only if it matches this exact order tuple and is not refunded or disputed.
export function paymentMatches(p, row, svc) {
  const m = p?.metadata || {};
  const bad = ['refunded', 'auto_refunded', 'partially_refunded', 'dispute_warning', 'dispute_needs_response',
    'dispute_warning_needs_response', 'resolution_needs_response', 'dispute_under_review', 'dispute_warning_under_review',
    'resolution_under_review', 'dispute_lost', 'resolution_lost'];
  return p?.status === 'paid' && !p.refunded_at && !bad.includes(p.substatus)
    && p.checkout_configuration_id === row.checkout_id
    && m.order_id === row.order_id && m.room_id === row.room_id && m.service_id === row.service_id
    && m.scope_hash === row.scope_hash && m.environment === row.environment
    && p.total?.currency === 'usd' && Number(p.total.amount) === svc.price_usd;
}

// Order status for the agent in that room.
// - No scope yet: returns needs_scope. The agent records the agreed scope once with `scope`.
// - Scope recorded: creates the Whop checkout bound to it (plan, order, room, service, scope hash, environment).
// - Paid: verified against Whop on every call, so a refund or dispute revokes it.
export async function orderStatus(room_id, whop, { appUrl, scope, env = process.env }) {
  const d = await db();
  let [row] = await d.query('SELECT * FROM hire_rooms WHERE room_id = $1', [room_id], queryOptions());
  if (!row) return null;
  const svc = SERVICES[row.service_id];
  const base = { service_id: row.service_id, agent: svc.agent, price_usd: svc.price_usd, currency: 'usd', environment: whop.environment };

  if (!row.scope) {
    if (typeof scope !== 'string' || !scope.trim()) return { ...base, needs_scope: true, checkout_url: null, paid: false };
    const s = scope.trim();
    if (s.length > 1000) throw new Error('bad scope: max 1000 characters');
    [row] = await d.query('UPDATE hire_rooms SET scope = $1, scope_hash = $2 WHERE room_id = $3 AND scope IS NULL RETURNING *',
      [s, scopeHash(s), room_id], queryOptions()).then((r) => (r.length ? r : d.query('SELECT * FROM hire_rooms WHERE room_id = $1', [room_id], queryOptions())));
  }

  if (!row.checkout_url) {
    const plan_id = planFor(row.service_id, env);
    if (!plan_id) return { ...base, scope: row.scope, checkout_url: null, paid: false, error: 'payments not configured for this service yet' };
    const created = await whop.checkoutConfigurations.create({
      account_id: whop.companyId, plan_id,
      metadata: { order_id: row.order_id, room_id, service_id: row.service_id, scope_hash: row.scope_hash, environment: whop.environment },
      redirect_url: `${appUrl}/paid`,
    }, { idempotencyKey: row.order_id });
    [row] = await d.query('UPDATE hire_rooms SET checkout_id = $1, checkout_url = $2, plan_id = $3, environment = $4 WHERE room_id = $5 RETURNING *',
      [created.id, created.purchase_url, plan_id, whop.environment, room_id], queryOptions());
  }

  let payment = null;
  if (row.payment_id) {
    payment = await whop.payments.retrieve({ id: row.payment_id });
  } else {
    let after;
    for (let page = 0; page < 4 && !payment; page++) {
      const res = await whop.payments.list({ account_id: whop.companyId, mode: 'account_sales', plan_id: row.plan_id, order: 'created_at', direction: 'desc', first: 50, ...(after ? { after } : {}) });
      payment = (res.data || []).find((p) => p.metadata?.order_id === row.order_id) || null;
      const info = res.response?.page_info || res.page_info;
      if (!info?.has_next_page) break;
      after = info.end_cursor;
    }
  }
  const valid = paymentMatches(payment, row, svc);
  if (payment && valid && !row.paid_at) {
    await d.query('UPDATE hire_rooms SET payment_id = $1, paid_at = now(), revoked_reason = NULL WHERE room_id = $2', [payment.id, room_id], queryOptions());
  } else if (row.paid_at && !valid) {
    await d.query('UPDATE hire_rooms SET revoked_reason = $1 WHERE room_id = $2', [payment?.substatus || payment?.status || 'payment not found', room_id], queryOptions());
  }
  return { ...base, scope: row.scope, checkout_url: row.checkout_url, paid: valid,
    ...(row.paid_at && !valid ? { revoked: true, reason: 'payment refunded, disputed or no longer valid' } : {}) };
}
