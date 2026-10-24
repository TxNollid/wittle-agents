import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSlop, checkRewrite, extractFacts } from './slop.mjs';
import { checkItinerary } from './guide.mjs';
import * as fr from './founder-review.mjs';
import { SPECIALISTS, validateCatalog, profileCard, LIVE_ON_RAILS } from './catalog.mjs';

const SLOPPY = `In today's fast-paced world, it's not just about building — it's about building smarter.
We're thrilled to unveil Acme 2.0, a game-changer that seamlessly helps you leverage robust insights.
Ever wondered why 73% of teams miss deadlines? The answer? Our cutting-edge platform.
Join 1,200 founders at https://acme.dev/beta or email hi@acme.dev. #AI #startups #productivity`;

const CLEAN = `Acme 2.0 is out. It shows you which tasks are about to slip, before they do.
73% of teams miss deadlines, mostly because nobody sees the slip coming.
1,200 founders already use it. Try the beta at https://acme.dev/beta or email hi@acme.dev.`;

test('slop score is higher for generated-sounding text', () => {
  const a = scoreSlop(SLOPPY), b = scoreSlop(CLEAN);
  assert.ok(a.score > 10, `sloppy score ${a.score}`);
  assert.equal(b.score, 0);
  const rules = new Set(a.hits.map((h) => h.rule));
  for (const r of ['phrase:game-changer', 'em_dash', 'hashtag_pile', 'phrase:in today\'s fast-paced']) assert.ok(rules.has(r), r);
});

test('facts include numbers, urls, emails and quotes but not url fragments', () => {
  const f = extractFacts('Paid $19 for "Pro" at https://x.com/a1 on 2026 — 40% off, ping @dill or a@b.co.');
  for (const x of ['$19', '"Pro"', 'https://x.com/a1', '2026', '40%', '@dill', 'a@b.co']) assert.ok(f.includes(x), x);
  assert.ok(!f.includes('1'));
});

test('good rewrite passes the gate', () => {
  const r = checkRewrite(SLOPPY, CLEAN);
  assert.deepEqual(r.reasons, []);
  assert.ok(r.ok);
});

test('rewrite that drops a fact or stays sloppy fails', () => {
  const dropped = checkRewrite(SLOPPY, CLEAN.replace('1,200 founders', 'Founders'));
  assert.ok(!dropped.ok);
  assert.deepEqual(dropped.missingFacts, ['1,200']);
  const same = checkRewrite(SLOPPY, SLOPPY);
  assert.ok(same.reasons.some((x) => x.includes('does not reduce')));
});

test('padded rewrite fails', () => {
  const r = checkRewrite('Ship it today. Costs $5.', 'Ship it today. Costs $5. '.repeat(6));
  assert.ok(r.reasons.some((x) => x.includes('padded')));
});

const NOW = new Date('2026-10-24T18:00:00Z');
const stop = (name, arrive, depart, transit, extra = {}) => ({
  name, address: `${name} St, Brooklyn, NY`, arrive, depart, why: 'Good fit.', cost_usd: 10,
  transit_min_from_prev: transit, source_url: `https://example.com/${name}`, checked_at: '2026-10-24T17:30:00Z', hours: '9am–9pm', ...extra,
});
const PLAN = {
  date: '2026-10-25', start: '10:00', end: '16:00', budget_usd: 60,
  stops: [stop('a', '10:00', '11:00', 0), stop('b', '11:20', '12:30', 15), stop('c', '12:45', '14:00', 10), stop('d', '14:20', '15:30', 15)],
};

test('valid itinerary passes', () => {
  const r = checkItinerary(PLAN, { now: NOW });
  assert.deepEqual(r.reasons, []);
  assert.equal(r.total_cost_usd, 40);
});

test('itinerary failures are specific', () => {
  const bad = structuredClone(PLAN);
  bad.stops[1].arrive = '11:05'; // before 11:00 + 15 min transit
  bad.stops[2].source_url = 'http://insecure.example.com';
  bad.stops[3].checked_at = '2026-10-22T10:00:00Z';
  bad.stops[0].hours = '';
  const r = checkItinerary(bad, { now: NOW });
  assert.ok(!r.ok);
  for (const want of ['arrives before', 'https source_url', 'checked 56h ago', 'hours must be']) {
    assert.ok(r.reasons.some((x) => x.includes(want)), want);
  }
});

test('itinerary over budget or too short fails', () => {
  const r = checkItinerary({ ...PLAN, budget_usd: 25, stops: PLAN.stops.slice(0, 3) }, { now: NOW });
  assert.ok(r.reasons.some((x) => x.includes('needs 4-7 stops')));
  assert.ok(r.reasons.some((x) => x.includes('exceeds budget')));
});

const T0 = '2026-10-24T18:00:00.000Z';
const h = (n) => new Date(Date.parse(T0) + n * 3.6e6).toISOString();
const newAddOn = () => fr.createAddOn({ addon_id: 'ad1', parent_order_id: 'o1', room_id: 'r1', price_minor: 2900, paid_at: T0 });

test('founder review happy path', () => {
  let a = newAddOn();
  assert.equal(a.deadline_at, h(48));
  a = fr.queue(a, { audit_delivered: true, at: h(0.2) });
  a = fr.linkSubmission(a, { submission_id: 's1', at: h(5) });
  assert.ok(fr.mayApprove(a, 's1', h(5)));
  assert.ok(!fr.mayApprove(a, 's2', h(5)));
  a = fr.markDelivered(a, { submission_id: 's1', message_id: 'm1', at: h(5.1) });
  assert.equal(a.state, 'delivered');
  assert.equal(fr.sweep(a, { at: h(100) }).state, 'delivered');
});

test('founder review refunds after deadline and never approves late', () => {
  let a = fr.queue(newAddOn(), { audit_delivered: true, at: h(1) });
  assert.equal(fr.sweep(a, { at: h(47) }).state, 'queued');
  a = fr.sweep(a, { at: h(48) });
  assert.equal(a.state, 'refund_due');
  assert.throws(() => fr.linkSubmission(a, { submission_id: 's1', at: h(49) }));
  a = fr.markRefunded(a, { refund_id: 'rf1', at: h(48.1) });
  assert.equal(a.state, 'refunded');

  let b = fr.linkSubmission(fr.queue(newAddOn(), { audit_delivered: true, at: h(1) }), { submission_id: 's1', at: h(40) });
  assert.ok(!fr.mayApprove(b, 's1', h(48)));
  assert.equal(fr.sweep(b, { at: h(48) }).state, 'refund_due');
});

test('founder review cannot queue before audit delivery', () => {
  assert.throws(() => fr.queue(newAddOn(), { audit_delivered: false, at: h(1) }), /audit must be delivered/);
});

test('add-on price needs 2x margin over Terac cost', () => {
  assert.ok(fr.priceOk(2900, 1450));
  assert.ok(!fr.priceOk(2900, 1451));
  assert.ok(!fr.priceOk(2900, 0));
});

test('catalog is valid and only the auditor is on live rails today', () => {
  assert.deepEqual(validateCatalog(), []);
  assert.equal(SPECIALISTS.length, 3);
  assert.deepEqual([...LIVE_ON_RAILS], ['website_audit_v1']);
  const card = profileCard('website_audit_v1');
  assert.match(card, /Built by Wittle Labs, an AI lab based in NYC\./);
  assert.doesNotMatch(card, /founder review/i, 'disabled add-on must not be advertised');
});

test('catalog validation catches bad entries', () => {
  const bad = [{ ...SPECIALISTS[0], agent_name: 'Anti Slop Editor Agent Deluxe', offer: { ...SPECIALISTS[0].offer, revisions: 2 } }];
  const errs = validateCatalog(bad);
  assert.ok(errs.some((e) => e.includes('agent_name')));
  assert.ok(errs.some((e) => e.includes('one revision')));
});
