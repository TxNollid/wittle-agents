import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { validateWire } from "../whop-payments/v2.mjs";

async function setup(t, options = {}) { const f = await fixture(options); t.after(() => f.close()); return f; }
const count = (f, table) => f.service.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test("real controller v2 receipt dispatches once in its original room without buyer approval", async (t) => {
  const f = await setup(t), worker = f.make();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => worker.dispatch(f.order.id)));
  assert(outcomes.every((outcome) => outcome.state === "running"));
  assert.equal(f.starts.length, 1);
  assert.equal(count(f, "runs"), 1);
  assert.equal(count(f, "project_jobs"), 1);
  assert.equal(count(f, "approvals"), 0);
  const job = outcomes[0].job;
  validateWire("Job", job);
  assert.equal(job.room_id, f.quote.offer.room_id);
  assert.equal(job.quote_hash, f.quote.quote_hash);
  assert.equal(job.buyer_id, f.quote.offer.buyer_id);
  assert.equal(job.prompt_version, "fixture_prompt_v1");
  assert.equal(f.c.viewOrder(f.operator, f.order.id).project.room_id, job.room_id);
  assert.equal(f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor, 5);
});

test("separate adapter instances use one durable compare-and-set before runtime start", async (t) => {
  const f = await setup(t);
  const [a, b] = [f.make(), f.make()];
  await Promise.all([a.dispatch(f.order.id), b.dispatch(f.order.id)]);
  assert.equal(f.starts.length, 1);
  assert.equal(count(f, "runs"), 1);
  assert.equal(a.inspect(f.order.id).state, "running");
});

test("persisted running dispatch survives database reopen without another start", async (t) => {
  const f = await setup(t), first = await f.make().dispatch(f.order.id);
  f.reopen();
  const after = await f.make().dispatch(f.order.id);
  assert.equal(after.job.attempt_id, first.job.attempt_id);
  assert.equal(after.state, "running");
  assert.equal(f.starts.length, 1);
});

for (const [field, replacement] of Object.entries({ order_id: "other_order", quote_id: "other_quote",
  quote_hash: "0".repeat(64), buyer_id: "other_buyer", room_id: "other_room", payment_id: "pay_other", environment: "live" })) {
  test(`mismatched acceptance ${field} cannot claim or start work`, async (t) => {
    const f = await setup(t);
    const worker = f.make({ paymentAcceptance: (id) => ({ ...f.service.v2.paymentAcceptance(id), [field]: replacement }) });
    await assert.rejects(worker.dispatch(f.order.id), { code: "PAYMENT_BINDING_MISMATCH" });
    assert.equal(count(f, "runs"), 0); assert.equal(f.starts.length, 0);
  });
}

test("pending payment and absence of authoritative acceptance cannot dispatch", async (t) => {
  const f = await setup(t, { paid: false });
  await assert.rejects(f.make().dispatch(f.order.id), { code: "V2_PAYMENT_REQUIRED" });
  assert.equal(f.starts.length, 0); assert.equal(count(f, "runs"), 0);
});

test("sandbox receipt cannot cross-authorize a live adapter", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.make({ mode: "live" }).dispatch(f.order.id), { code: "ENVIRONMENT_MISMATCH" });
  assert.equal(f.starts.length, 0);
});

test("late acceptance and current supersession both reject before claim", async (t) => {
  const f = await setup(t);
  const worker = f.make({ paymentAcceptance: (id) => ({ ...f.service.v2.paymentAcceptance(id), accepted_at: f.quote.offer.expires_at }) });
  await assert.rejects(worker.dispatch(f.order.id), { code: "LATE_PAYMENT" });
  f.service.db.prepare("UPDATE quotes SET state='superseded'").run();
  await assert.rejects(f.make().dispatch(f.order.id), { code: "PAYMENT_INELIGIBLE" });
  assert.equal(count(f, "runs"), 0);
});

test("scope changed after acceptance does not replace a pinned dispatch binding", async (t) => {
  const f = await setup(t), worker = f.make();
  await worker.dispatch(f.order.id);
  const order = f.c.viewOrder(f.operator, f.order.id);
  order.quote_snapshot.offer.scope.goal = "changed scope";
  f.service.db.prepare("UPDATE orders SET quote_snapshot=? WHERE id=?").run(JSON.stringify(order.quote_snapshot), f.order.id);
  const after = await worker.dispatch(f.order.id);
  assert.equal(after.state, "cancelled"); assert.equal(f.starts.length, 1); assert.equal(f.cancels.length, 1);
});

for (const bad of ["stale", "boundary", "capacity", "expired", "inputs", "budget"]) {
  test(`unavailable ${bad} readiness retains paid pending job without a run`, async (t) => {
    const f = await setup(t), original = f.runtime.check;
    f.runtime.check = async (...args) => {
      const check = await original(...args);
      if (bad === "stale") check.readiness.stale = true;
      if (bad === "boundary") check.readiness.credential_boundary_verified = false;
      if (bad === "capacity") check.readiness.available_slots = 0;
      if (bad === "expired") check.readiness.expires_at = new Date(f.now()).toISOString();
      if (bad === "inputs") check.inputs_ready = false;
      if (bad === "budget") check.budget_minor = 101;
      return check;
    };
    const result = await f.make().dispatch(f.order.id);
    assert.equal(result.state, "paid_waiting"); assert.equal(count(f, "project_jobs"), 1);
    assert.equal(count(f, "runs"), 0); assert.equal(f.starts.length, 0);
  });
}

test("membership lookup failure is never a cached room permission", async (t) => {
  const f = await setup(t);
  f.membership = async () => null;
  await assert.rejects(f.make().dispatch(f.order.id), { code: "MEMBERSHIP_UNAVAILABLE" });
  assert.equal(f.starts.length, 0); assert.equal(count(f, "runs"), 0);
});

test("wrong-room project adapter cannot establish paid readiness", async (t) => {
  const f = await setup(t, { wrongRoom: true });
  const state = await f.make().dispatch(f.order.id);
  assert.equal(state.state, "needs_attention");
  assert.equal(f.c.viewOrder(f.operator, f.order.id).project.access_ready, 0);
  assert.equal(f.starts.length, 0);
});

test("definitely-not-sent retries retain one attempt and stop at persisted cap/backoff", async (t) => {
  const f = await setup(t);
  f.runtime.start = async (args) => { f.starts.push(args); return f.receipt(args, "not_sent"); };
  let worker = f.make({ maxStarts: 2 });
  const first = await worker.dispatch(f.order.id);
  assert.equal(first.state, "paid_waiting");
  await worker.dispatch(f.order.id); assert.equal(f.starts.length, 1);
  f.reopen(); worker = f.make({ maxStarts: 2 });
  f.advance(100);
  const second = await worker.dispatch(f.order.id);
  assert.equal(second.reason, "retry_limit");
  assert.equal(second.job.attempt_id, first.job.attempt_id);
  f.advance(10000); await worker.dispatch(f.order.id);
  assert.equal(f.starts.length, 2); assert.equal(count(f, "runs"), 1);
});

test("lost acknowledgement survives reopen and reconciles existing run without replay", async (t) => {
  const f = await setup(t), original = f.runtime.start;
  f.runtime.start = async (args) => { await original(args); throw new Error("response lost after remote start"); };
  let worker = f.make();
  const initial = await worker.dispatch(f.order.id);
  assert.equal(initial.reason, "unknown_start_outcome");
  f.reopen(); worker = f.make();
  await worker.dispatch(f.order.id); assert.equal(f.starts.length, 1);
  const recovered = await worker.reconcile(f.order.id);
  assert.equal(recovered.state, "running"); assert.equal(recovered.job.attempt_id, initial.job.attempt_id);
  assert.equal(f.starts.length, 1);
});

test("unknown delivery acknowledgement cannot cause another audit start", async (t) => {
  const f = await setup(t), original = f.runtime.start;
  f.runtime.start = async (args) => ({ ...await original(args), state: "needs_attention", reason: "unknown_send_outcome" });
  const worker = f.make();
  assert.equal((await worker.dispatch(f.order.id)).reason, "unknown_send_outcome");
  await worker.dispatch(f.order.id); await worker.drain();
  assert.equal(f.starts.length, 1);
});

test("start timeout is ambiguous and never retried automatically", async (t) => {
  const f = await setup(t);
  f.runtime.start = async (args) => { f.starts.push(args); return new Promise(() => {}); };
  const worker = f.make({ timeoutMs: 20 });
  assert.equal((await worker.dispatch(f.order.id)).reason, "unknown_start_outcome");
  await worker.dispatch(f.order.id); assert.equal(f.starts.length, 1);
});

test("reconciliation rejects mismatched receipt and not-found is not not-sent", async (t) => {
  const f = await setup(t);
  f.runtime.start = async (args) => { f.starts.push(args); throw new Error("unknown outcome"); };
  const worker = f.make(); await worker.dispatch(f.order.id);
  f.runtime.status = async (args) => ({ ...f.receipt(args, "running"), room_id: "other_room" });
  assert.equal((await worker.reconcile(f.order.id)).reason, "status_receipt_mismatch");
  f.runtime.status = async (args) => f.receipt(args, "unknown");
  assert.equal((await worker.reconcile(f.order.id)).state, "needs_attention");
  assert.equal(f.starts.length, 1);
});

test("operator-confirmed not-sent permits only the same attempt/key retry", async (t) => {
  const f = await setup(t);
  f.runtime.start = async (args) => { f.starts.push(args); throw new Error("unknown"); };
  const worker = f.make(); const first = await worker.dispatch(f.order.id);
  f.runtime.status = async (args) => f.receipt(args, "not_sent");
  assert.equal((await worker.reconcile(f.order.id)).state, "paid_waiting");
  f.advance(100); await worker.dispatch(f.order.id);
  assert.equal(f.starts[1].request_id, f.starts[0].request_id);
  assert.equal(f.starts[1].job.attempt_id, first.job.attempt_id);
  assert.equal(count(f, "runs"), 1);
});

test("refund during start cancels remote work and future action authority", async (t) => {
  const f = await setup(t), original = f.runtime.start;
  f.runtime.start = async (args) => { const receipt = await original(args); await assert.rejects(f.refund()); return receipt; };
  const worker = f.make(), result = await worker.dispatch(f.order.id);
  assert.equal(result.state, "cancelled"); assert.equal(f.cancels.length, 1);
  await assert.rejects(worker.authorizeAction(f.order.id, result.job.attempt_id,
    { request_id: "after_refund_0001", action: "browse_public_pages", amount_minor: 1 }), { code: "ACTION_REVOKED" });
  assert.equal(f.c.viewOrder(f.operator, f.order.id).payment_status, "refunded");
});

test("negative-state drain and lost membership stop already running jobs", async (t) => {
  const f = await setup(t), worker = f.make(); await worker.dispatch(f.order.id);
  f.membership = async () => ({ ...f.proof(), revoked_at: new Date(f.now()).toISOString() });
  await assert.rejects(worker.authorizeAction(f.order.id, f.starts[0].job.attempt_id,
    { request_id: "revoked_action_0001", action: "browse_public_pages", amount_minor: 1 }), { code: "MEMBERSHIP_UNAVAILABLE" });
  await worker.drain();
  assert.equal(worker.inspect(f.order.id).state, "cancelled"); assert.equal(f.cancels.length, 1);
});

test("unconfirmed cancellation remains attention and never restores action access", async (t) => {
  const f = await setup(t), worker = f.make(); await worker.dispatch(f.order.id);
  f.runtime.cancel = async () => { throw new Error("cancel acknowledgement lost"); };
  assert.equal((await worker.cancel(f.order.id, "operator_stop")).reason, "cancellation_unconfirmed");
  await assert.rejects(worker.authorizeAction(f.order.id, f.starts[0].job.attempt_id,
    { request_id: "stopped_action_0001", action: "browse_public_pages", amount_minor: 1 }), { code: "ACTION_REVOKED" });
  assert.equal((await worker.reconcile(f.order.id)).state, "needs_attention");
});

test("operator stop during preflight cannot claim or start afterward", async (t) => {
  const f = await setup(t), worker = f.make(), original = f.runtime.check;
  f.runtime.check = async (args) => { await worker.cancel(f.order.id, "operator_stop"); return original(args); };
  assert.equal((await worker.dispatch(f.order.id)).state, "cancelled");
  assert.equal(count(f, "runs"), 0); assert.equal(f.starts.length, 0);
});

test("original controller cost policy, budget and lease remain action authority", async (t) => {
  const f = await setup(t), worker = f.make(), run = await worker.dispatch(f.order.id);
  const authorize = (input) => worker.authorizeAction(f.order.id, run.job.attempt_id, input);
  await assert.rejects(authorize({ request_id: "forbidden_action_01", action: "publish_website", amount_minor: 1 }), { status: 403 });
  await assert.rejects(authorize({ request_id: "over_budget_action_1", action: "browse_public_pages", amount_minor: 96 }), { status: 409 });
  f.advance(15 * 60000 + 1);
  await assert.rejects(authorize({ request_id: "expired_action_0001", action: "browse_public_pages", amount_minor: 1 }), { status: 409 });
});
