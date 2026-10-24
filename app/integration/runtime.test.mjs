import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAuditRuntime } from "./runtime.mjs";
import { fixtureJob } from "../auditor/fixtures.mjs";

const costs = { browse_public_pages: 1, write_audit_report: 1, deliver_in_bound_room: 1 };
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const args = () => ({ job: fixtureJob(), request_id: "runtime_fixture_request_01", authorizeAction: async () => ({ reserved: true }) });
const make = (db, execute) => createAuditRuntime({ db, mode: "fixture", costs, readHealth: async () => { throw new Error("Not used by these state-machine cases"); }, execute });

test("cancel while action authority is awaited prevents the protected action and late result", async () => {
  const db = new DatabaseSync(":memory:"), started = deferred(), release = deferred();
  let effects = 0;
  const input = { ...args(), authorizeAction: async () => { started.resolve(); await release.promise; return { reserved: true }; } };
  const runtime = make(db, async (_job, context) => { await context.authorize("audit"); effects++; return { report: "must not be accepted" }; });
  try {
    runtime.start(input); await started.promise;
    const stop = runtime.cancel(input); release.resolve();
    assert.equal((await stop).state, "cancelled"); await runtime.idle();
    assert.equal(effects, 0);
    assert.throws(() => runtime.result(input), (error) => error.code === "RESULT_UNAVAILABLE");
    assert.equal(runtime.start(input).state, "cancelled"); assert.equal(effects, 0);
  } finally { await runtime.close(); db.close(); }
});

test("a confirmed local stop survives reopen and cannot dispatch the same request again", async () => {
  const db = new DatabaseSync(":memory:"); let calls = 0;
  const execute = async () => { calls++; return { report: "must not run" }; };
  const first = make(db, execute), input = args();
  try {
    first.start(input);
    assert.equal((await first.cancel(input)).state, "cancelled");
    await first.close();
    const reopened = make(db, execute);
    assert.equal(reopened.start(input).state, "cancelled"); await reopened.idle();
    assert.equal(calls, 0); await reopened.close();
  } finally { await first.close(); db.close(); }
});

test("interrupted running metadata stays attention and an old completion cannot overwrite it", async () => {
  const db = new DatabaseSync(":memory:"), started = deferred(), release = deferred(); let calls = 0;
  const old = make(db, async () => { calls++; started.resolve(); await release.promise; return { report: "late output" }; });
  const input = args();
  try {
    old.start(input); await started.promise;
    const reopened = make(db, async () => { calls++; return { report: "duplicate" }; });
    assert.equal(reopened.start(input).state, "needs_attention"); assert.equal(calls, 1);
    release.resolve(); await old.idle();
    assert.equal(reopened.status(input).state, "needs_attention");
    assert.equal(reopened.status(input).reason, "RUNTIME_PROCESS_INTERRUPTED");
    assert.throws(() => reopened.result(input), (error) => error.code === "RESULT_UNAVAILABLE");
    assert.equal((await reopened.cancel(input)).state, "needs_attention");
    assert.equal(reopened.start(input).state, "needs_attention"); assert.equal(calls, 1);
    await reopened.close();
  } finally { release.resolve(); await old.close(); db.close(); }
});

test("the same runtime request cannot be rebound to another buyer room or attempt", async () => {
  const db = new DatabaseSync(":memory:"); let calls = 0;
  const runtime = make(db, async () => { calls++; return {}; });
  const input = args();
  try {
    runtime.start(input);
    assert.throws(() => runtime.start({ ...input, job: { ...input.job, room_id: "other_private_room" } }),
      (error) => error.code === "RUNTIME_BINDING_MISMATCH");
    assert.throws(() => runtime.start({ ...input, job: { ...input.job, attempt_id: "other_attempt" } }),
      (error) => error.code === "RUNTIME_BINDING_MISMATCH");
    await runtime.cancel(input); assert.equal(calls, 0);
  } finally { await runtime.close(); db.close(); }
});
