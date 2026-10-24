import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }
const action = (request_id) => ({ request_id, action: "browse_public_pages", amount_minor: 1 });
const spent = (f) => f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor;

for (const outcome of ["unknown", "not_sent", "error"]) {
  test(`concurrent stop wins over stale ${outcome} reconciliation and survives reopen`, async (t) => {
    const f = await setup(t), worker = f.make();
    const running = await worker.dispatch(f.order.id);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.runtime.status = async (args) => {
      entered.resolve(); await release.promise;
      if (outcome === "error") throw new Error("status failed after stop");
      return f.receipt(args, outcome);
    };
    const reconciling = worker.reconcile(f.order.id);
    await entered.promise;
    await worker.cancel(f.order.id, "operator_stop");
    release.resolve();
    assert.equal((await reconciling).state, "cancelled");
    await assert.rejects(worker.authorizeAction(f.order.id, running.job.attempt_id, action("stopped_race_action")), { code: "ACTION_REVOKED" });
    assert.equal(spent(f), 5);
    f.reopen();
    assert.equal((await f.make().dispatch(f.order.id)).state, "cancelled");
    assert.equal(f.starts.length, 1);
  });
}

test("an older failed cancel cannot downgrade a concurrently confirmed stop", async (t) => {
  const f = await setup(t), worker = f.make(); await worker.dispatch(f.order.id);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const normalCancel = f.runtime.cancel;
  let calls = 0;
  f.runtime.cancel = async (args) => {
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error("older cancel response lost"); }
    return normalCancel(args);
  };
  const older = worker.cancel(f.order.id, "operator_stop");
  await entered.promise;
  assert.equal((await worker.cancel(f.order.id, "operator_stop")).state, "cancelled");
  release.resolve();
  assert.equal((await older).state, "cancelled");
  assert.equal(worker.inspect(f.order.id).state, "cancelled");
});

test("cancel during local-claim reconciliation cannot restore pending or reserve a run", async (t) => {
  const f = await setup(t), originalCheck = f.runtime.check;
  f.runtime.check = async (args) => { const health = await originalCheck(args); health.readiness.stale = true; return health; };
  await f.make().dispatch(f.order.id);
  f.service.db.prepare("UPDATE fulfillment_dispatch SET phase='claiming'").run();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const worker = f.make({ paymentAcceptance: async (id) => {
    entered.resolve(); await release.promise; return f.service.v2.paymentAcceptance(id);
  } });
  const recovery = worker.reconcile(f.order.id);
  await entered.promise;
  await worker.cancel(f.order.id, "operator_stop");
  release.resolve();
  assert.equal((await recovery).state, "cancelled");
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM runs").get().n, 0);
  assert.equal(f.starts.length, 0);
});

test("runtime health expiring during dispatch membership I/O prevents the controller claim", async (t) => {
  const f = await setup(t), originalCheck = f.runtime.check, normalMembership = f.membership;
  f.runtime.check = async (args) => { const result = await originalCheck(args); result.readiness.expires_at = new Date(f.now() + 10).toISOString(); return result; };
  let calls = 0;
  f.membership = async (args) => { if (++calls === 2) f.advance(11); return normalMembership(args); };
  const result = await f.make().dispatch(f.order.id);
  assert.equal(result.state, "paid_waiting"); assert.equal(result.reason, "RUNTIME_UNAVAILABLE");
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM runs").get().n, 0);
  assert.equal(f.starts.length, 0);
});

for (const expiring of ["membership", "runtime"]) {
  test(`${expiring} expiry during final payment lookup denies action without spend`, async (t) => {
    const f = await setup(t);
    let armed = false, reads = 0;
    const worker = f.make({ paymentAcceptance: async (id) => {
      if (armed && ++reads === 2) f.advance(11);
      return f.service.v2.paymentAcceptance(id);
    } });
    const running = await worker.dispatch(f.order.id);
    if (expiring === "membership") {
      const normalMembership = f.membership;
      f.membership = async (args) => ({ ...await normalMembership(args), expires_at: new Date(f.now() + 10).toISOString() });
    } else {
      const normalCheck = f.runtime.check;
      f.runtime.check = async (args) => { const result = await normalCheck(args); result.readiness.expires_at = new Date(f.now() + 10).toISOString(); return result; };
    }
    armed = true;
    await assert.rejects(worker.authorizeAction(f.order.id, running.job.attempt_id, action("expired_final_lookup")),
      { code: expiring === "membership" ? "MEMBERSHIP_UNAVAILABLE" : "RUNTIME_UNAVAILABLE" });
    assert.equal(spent(f), 5);
  });
}
