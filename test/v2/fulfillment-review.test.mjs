import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixture } from "../../app/fulfillment/fixture.mjs";
const files = ["fulfillment/index.mjs", "fulfillment/fixture.mjs", "whop-payments/controller.mjs", "whop-payments/server.mjs", "whop-payments/v2.mjs"];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(new URL(`../../app/${file}`, import.meta.url))).digest("hex")]));
const before = hashes();
const action = request_id => ({ request_id, action: "browse_public_pages", amount_minor: 1 });
async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }

test("operator cancellation wins against an earlier in-flight running-status response", async t => {
  const f = await setup(t), worker = f.make();
  const running = await worker.dispatch(f.order.id);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.runtime.status = async args => {
    const stale = f.receipt(args, "running");
    entered.resolve();
    await release.promise;
    return stale;
  };
  const reconciling = worker.reconcile(f.order.id);
  await entered.promise;
  assert.equal((await worker.cancel(f.order.id, "operator_stop")).state, "cancelled");
  release.resolve();
  const result = await reconciling;
  const authorization = await Promise.allSettled([worker.authorizeAction(f.order.id, running.job.attempt_id, action("qa_after_stop"))]);
  console.log("QA_CANCEL_RACE " + JSON.stringify({ after_status: result.state, action: authorization[0].status, spent_minor: f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor }));
  assert.equal(authorization[0].status, "rejected", "stale running receipt must not restore stopped action authority");
  assert.equal(worker.inspect(f.order.id).state, "cancelled");
});

test("membership proof expiring during runtime health I/O cannot authorize a new effect", async t => {
  const f = await setup(t), worker = f.make();
  const running = await worker.dispatch(f.order.id), check = f.runtime.check;
  f.membership = async () => ({ ...f.proof(), expires_at: new Date(f.now() + 10).toISOString(), mode: "fixture", evidence_level: "fixture" });
  f.runtime.check = async () => { f.advance(11); return check(); };
  const authorization = await Promise.allSettled([worker.authorizeAction(f.order.id, running.job.attempt_id, action("qa_expired_membership"))]);
  console.log("QA_MEMBERSHIP_EXPIRY " + JSON.stringify({ action: authorization[0].status, spent_minor: f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor }));
  assert.equal(authorization[0].status, "rejected", "authority must still be current at reserveCost");
  assert.equal(f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor, 5);
});

test("result-ready receipt does not create delivered or successful-order evidence", async t => {
  const f = await setup(t), worker = f.make(), start = f.runtime.start;
  f.runtime.start = async args => ({ ...await start(args), state: "result_ready" });
  const result = await worker.dispatch(f.order.id);
  assert.equal(result.state, "result_ready");
  const order = f.c.viewOrder(f.operator, f.order.id);
  assert.notEqual(order.workflow_status, "delivered");
  assert.notEqual(order.workflow_status, "completed");
  assert.equal(f.starts.length, 1);
  assert.equal(f.service.db.prepare("SELECT status FROM runs").get().status, "running");
});

after(() => {
  assert.deepEqual(hashes(), before, "Candidate changed during independent review");
  console.log("QA_FULFILLMENT_SHA256 " + JSON.stringify(before));
});
