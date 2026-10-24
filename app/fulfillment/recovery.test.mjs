import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { readBuyerReadiness } from "../solari-agent/execution-policy.mjs";

async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }

for (const committed of [false, true]) {
  test(`crash ${committed ? "after" : "before"} local claim commit reconciles without a second attempt`, async (t) => {
    const f = await setup(t), normalCheck = f.runtime.check;
    f.runtime.check = async (args) => { const result = await normalCheck(args); result.readiness.available_slots = 0; return result; };
    let worker = f.make(); await worker.dispatch(f.order.id);
    const saved = f.service.db.prepare("SELECT * FROM fulfillment_dispatch WHERE order_id=?").get(f.order.id);
    let claimed;
    if (committed) {
      const ready = await f.c.provision(f.operator, f.order.id);
      f.c.readiness(f.operator, f.order.id, { expected_version: ready.project.version, inputs_ready: true, capacity_ready: true, budget_minor: 100 });
      claimed = f.c.claimRun(f.operator, f.order.id, { request_id: saved.claim_key });
    }
    // Failure injection models death before local adapter persisted job/start intent.
    f.service.db.prepare("UPDATE fulfillment_dispatch SET phase='claiming' WHERE order_id=?").run(f.order.id);
    f.reopen(); worker = f.make();
    assert.equal((await worker.dispatch(f.order.id)).state, "needs_attention");
    assert.equal(f.starts.length, 0);
    await worker.reconcile(f.order.id);
    f.runtime.check = normalCheck;
    const recovered = await worker.dispatch(f.order.id);
    assert.equal(recovered.state, "running"); assert.equal(f.starts.length, 1);
    assert.equal(f.service.db.prepare("SELECT count(*) n FROM runs").get().n, 1);
    if (committed) assert.equal(recovered.job.attempt_id, claimed.id);
  });
}

test("current negative buyer-runtime policy retains paid_waiting and does not fall back to sessions", async (t) => {
  const f = await setup(t), check = f.runtime.check;
  f.membership = async () => ({ ...f.proof(), mode: "sandbox", evidence_level: "provider" });
  f.runtime.check = async (args) => ({ ...await check(args), mode: "sandbox", evidence_level: "local_execution",
    readiness: readBuyerReadiness(f.now()) });
  const state = await f.make({ mode: "sandbox" }).dispatch(f.order.id);
  assert.equal(state.state, "paid_waiting"); assert.equal(state.reason, "RUNTIME_UNAVAILABLE");
  assert.equal(f.starts.length, 0); assert.equal(f.service.db.prepare("SELECT count(*) n FROM runs").get().n, 0);
});

test("synthetic membership cannot authorize real-mode dispatch even with a true boundary flag", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.make({ mode: "sandbox" }).dispatch(f.order.id), { code: "MEMBERSHIP_UNAVAILABLE" });
  assert.equal(f.starts.length, 0);
});

test("running action does not need an additional free runtime slot", async (t) => {
  const f = await setup(t), worker = f.make(), running = await worker.dispatch(f.order.id);
  const normalCheck = f.runtime.check;
  f.runtime.check = async (args) => { const result = await normalCheck(args); result.readiness.available_slots = 0; return result; };
  const reservation = await worker.authorizeAction(f.order.id, running.job.attempt_id,
    { request_id: "occupied_slot_action", action: "browse_public_pages", amount_minor: 1 });
  assert.equal(reservation.amount_minor, 1);
  assert.equal(f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor, 6);
});

test("runtime preflight outage is pending, not a fictitious start or success", async (t) => {
  const f = await setup(t);
  f.runtime.check = async () => { throw new Error("offline"); };
  const state = await f.make().dispatch(f.order.id);
  assert.equal(state.state, "paid_waiting"); assert.equal(state.reason, "RUNTIME_UNAVAILABLE");
  assert.equal(state.job, null); assert.equal(f.starts.length, 0);
});

test("refund discovered on next drain requests cancellation without a buyer message", async (t) => {
  const f = await setup(t), worker = f.make(); await worker.dispatch(f.order.id);
  await assert.rejects(f.refund(), { status: 422 });
  await worker.drain();
  assert.equal(worker.inspect(f.order.id).state, "cancelled"); assert.equal(f.cancels.length, 1);
  assert.equal(f.service.v2.paymentAcceptance(f.order.id).payment_id, f.payment.id);
});
