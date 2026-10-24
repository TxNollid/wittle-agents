import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = Date.parse("2026-10-24T18:00:00.000Z");
const load = () => import(`../lib/stats.mjs?case=${randomUUID()}`);
function configure(mode) {
  process.env.WITTLE_WEB_MODE = mode;
  process.env.WITTLE_STATS_URL = "https://payments.example.test/api/payment-snapshot";
  process.env.WITTLE_STATS_TOKEN = randomUUID(); // Disposable synthetic credential only.
}
function source(mode, evidence_level, last_success_at) {
  return {
    mode,
    evidence_level,
    last_success_at,
    ledger_complete: false,
    ledger: [{
      payment_id: "synthetic_payment",
      order_id: "synthetic_order",
      environment: "sandbox",
      customer_classification: "unknown",
      currency: "USD",
      gross_minor: 1900,
      refunded_minor: 300,
      provider_verified: true,
      state: "refunded",
      at: new Date(base).toISOString(),
    }],
    activity: [],
  };
}

test("configured fixture source never falls back to demo counts and retains prior success after null freshness or failure", async (t) => {
  configure("fixture");
  t.mock.timers.enable({ apis: ["Date"], now: base });
  let payload = source("fixture", "fixture", null);
  let unavailable = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (unavailable) throw new Error("private upstream diagnostic");
    return Response.json(payload);
  });
  const { getStats } = await load();
  assert.deepEqual(await getStats(), {
    data: null, mode: "fixture", state: "unavailable", refresh_failed: true,
  });
  t.mock.timers.tick(10001);
  payload.last_success_at = new Date(Date.now()).toISOString();
  const success = await getStats();
  assert.equal(success.state, "fresh");
  assert.equal(success.data.revenue.sandbox.net_minor, 1600);
  assert.equal(success.data.revenue.sandbox.pending_minor, null);
  t.mock.timers.tick(10001);
  payload.last_success_at = null;
  const missingFreshness = await getStats();
  assert.equal(missingFreshness.state, "stale");
  assert.equal(missingFreshness.refresh_failed, true);
  assert.deepEqual(missingFreshness.data, { ...success.data, stale: true });
  t.mock.timers.tick(10001);
  unavailable = true;
  const failed = await getStats();
  assert.deepEqual(failed, missingFreshness);
  assert(!JSON.stringify(failed).includes("private upstream diagnostic"));
});

test("real mode rejects local execution evidence and retains matching provider evidence on later mode mismatch", async (t) => {
  configure("sandbox");
  t.mock.timers.enable({ apis: ["Date"], now: base });
  // Synthetic payload labels exercise the gate, not actual provider proof.
  let payload = source("sandbox", "local_execution", new Date(base).toISOString());
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const { getStats } = await load();
  assert.equal((await getStats()).data, null);
  t.mock.timers.tick(10001);
  payload.evidence_level = "provider";
  const accepted = await getStats();
  assert.equal(accepted.state, "fresh");
  t.mock.timers.tick(10001);
  payload.mode = "live";
  const mismatch = await getStats();
  assert.equal(mismatch.state, "stale");
  assert.deepEqual(mismatch.data, { ...accepted.data, stale: true });
});

test("missing private source collections cannot become authoritative empty totals", async (t) => {
  configure("fixture");
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const payload = source("fixture", "fixture", new Date(base).toISOString());
  delete payload.ledger;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const { getStats } = await load();
  const result = await getStats();
  assert.equal(result.state, "unavailable");
  assert.equal(result.data, null);
});
