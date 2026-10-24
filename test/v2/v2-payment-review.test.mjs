import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixture, admin } from "./payment-review-fixture.mjs";
import { projectPublicStats } from "../../app/stats/index.mjs";

const candidateFiles = ["whop-payments/server.mjs", "whop-payments/controller.mjs", "whop-payments/v2.mjs", "contracts/v2.schema.json", "contracts/valid.json", "stats/index.mjs"];
const hashes = () => Object.fromEntries(candidateFiles.map((file) => [file,
  createHash("sha256").update(readFileSync(new URL(`../../app/${file}`, import.meta.url))).digest("hex"),
]));
const before = hashes();
function setup(t) { const f = fixture(); t.after(() => f.close()); return f; }

test("wire input rejects prototype-named unknown fields before provider effects", async (t) => {
  const f = setup(t);
  const injected = JSON.parse('{"constructor":{"buyer_id":"other"},"__proto__":{"room_id":"other"}}');
  await assert.rejects(f.quote(injected), { status: 400 });
  assert.equal(f.state.createCalls, 0);
});

test("seller revoked after failed checkout cannot create a checkout on retry", async (t) => {
  const f = setup(t);
  f.state.onCreate = async () => { throw new Error("Synthetic provider outage before response"); };
  await assert.rejects(f.quote(), /Synthetic provider outage/);
  assert.equal(f.state.createCalls, 1);
  f.c.revoke(admin, f.template.seller_id);
  f.state.onCreate = null;
  await assert.rejects(f.quote(), { status: 403 });
  assert.equal(f.state.createCalls, 1, "Revoked seller must be rejected before another provider create");
});

test("unknown checkout response retry uses persisted order key and creates no approvals", async (t) => {
  const f = setup(t), keys = [];
  f.state.onCreate = async (_request, key) => {
    keys.push(key);
    if (keys.length === 1) throw new Error("Synthetic lost acknowledgement");
  };
  await assert.rejects(f.quote(), /lost acknowledgement/);
  f.advance(1000);
  const q = await f.quote();
  assert.deepEqual(keys, [f.order(q).id, f.order(q).id]);
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM approvals").get().n, 0);
  const p = f.payment(q);
  await f.service.reconcile(p.id);
  assert.equal(f.service.v2.paymentAcceptance(f.order(q).id).quote_hash, q.quote_hash);
});

test("in-flight superseded checkout cannot return or authorize a late old payment", async (t) => {
  const f = setup(t);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let oldKey;
  f.state.onCreate = async (_request, key) => {
    if (!oldKey) { oldKey = key; started.resolve(); await release.promise; }
  };
  const first = f.quote();
  const rejected = assert.rejects(first, { status: 409 });
  await started.promise;
  let replacement;
  try { replacement = await f.quote({ request_id: "qa_replacement_0001", scope_summary: "Changed agreed goal" }); }
  finally { release.resolve(); }
  await rejected;
  const old = f.service.db.prepare("SELECT * FROM orders WHERE id=?").get(oldKey);
  assert.equal(replacement.offer.supersedes, old.quote_id);
  await f.service.reconcile(f.payment({ quote_id: old.quote_id }).id);
  assert.equal(f.service.v2.paymentAcceptance(old.id), null);
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM project_jobs").get().n, 0);
  assert.equal((await f.status({ quote_id: old.quote_id })).state, "needs_attention");
});

test("refund timestamp without amount survives a later stale success in buyer status", async (t) => {
  const f = setup(t), q = await f.quote();
  await f.service.reconcile(f.payment(q).id);
  await assert.rejects(f.service.reconcile(f.payment(q, { refunded_at: new Date(f.now()).toISOString() }).id), { status: 422 });
  assert.equal((await f.status(q)).refund_status, "pending");
  await f.service.reconcile(f.payment(q).id);
  const status = await f.status(q);
  assert.equal(status.state, "needs_attention");
  assert.equal(status.refund_status, "pending", "A stale success must not erase observed pending-refund evidence");
});

test("a stale pending snapshot cannot erase a previously verified receipt from stats", async (t) => {
  const f = setup(t), q = await f.quote();
  await f.service.reconcile(f.payment(q).id);
  await f.service.reconcile(f.payment(q, { status: "pending", substatus: "pending" }).id);
  const stats = projectPublicStats(f.service.paymentSnapshot(), new Date(f.now()));
  assert.equal(stats.counts.paid_orders, 1);
  assert.equal(stats.revenue.sandbox.gross_minor, 1900);
});

test("multiple valid payments remain separately visible and hold the original order", async (t) => {
  const f = setup(t), q = await f.quote();
  const first = f.payment(q);
  await f.service.reconcile(first.id);
  const second = f.payment(q, { id: "pay_qaduplicate" });
  await assert.rejects(f.service.reconcile(second.id), { status: 409 });
  assert.equal((await f.status(q)).state, "needs_attention");
  const ledger = f.service.paymentSnapshot().ledger;
  assert.deepEqual(new Set(ledger.map((r) => r.payment_id)), new Set([first.id, second.id]));
  const stats = projectPublicStats(f.service.paymentSnapshot(), new Date(f.now()));
  assert.equal(stats.counts.paid_orders, 1);
  assert.equal(stats.revenue.sandbox.gross_minor, 3800);
  assert.equal(stats.revenue.external_live.gross_minor, 0);
  for (const privateId of [first.id, second.id, f.order(q).id, q.quote_id, f.template.room_id, f.template.buyer_id]) {
    assert.equal(JSON.stringify(stats).includes(privateId), false);
  }
});

test("membership lost during checkout prevents response and subsequent status disclosure", async (t) => {
  const f = setup(t);
  f.state.onCreate = async () => { f.state.allow = false; };
  await assert.rejects(f.quote(), { status: 403 });
  const q = f.service.db.prepare("SELECT id FROM quotes").get();
  await assert.rejects(f.status({ quote_id: q.id }), { status: 403 });
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM payment_acceptances").get().n, 0);
});

after(() => {
  assert.deepEqual(hashes(), before, "Sources changed during independent review run");
  console.log("QA_CANDIDATE_SHA256 " + JSON.stringify(before));
});
