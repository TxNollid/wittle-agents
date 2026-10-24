// Executes the repaired authority races over real loopback HTTP and the actual SQLite/controller.
// All identity, payment and runtime/provider facts remain synthetic.
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

const f = await fixture();
const originalHealth = f.runtime.check, originalMembership = f.membership;
const runs = new Map(), entered = Promise.withResolvers(), release = Promise.withResolvers();
let holdStatus = false, healthAdvance = 0, starts = 0, cancellations = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const args = JSON.parse(Buffer.concat(chunks).toString());
  let result;
  if (request.url === "/health") {
    f.advance(healthAdvance);
    result = await originalHealth();
  } else if (request.url === "/start") {
    starts++;
    result = f.receipt(args, "running"); runs.set(args.request_id, result);
  } else if (request.url === "/cancel") {
    cancellations++;
    result = f.receipt(args, "cancelled"); runs.set(args.request_id, result);
  } else {
    result = structuredClone(runs.get(args.request_id) || f.receipt(args, "unknown"));
    if (holdStatus) { entered.resolve(); await release.promise; }
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result));
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const call = async (path, { job, request_id, signal }) => {
    const response = await fetch(origin + path, { method: "POST", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job, request_id }) });
    return response.json();
  };
  f.runtime.check = (args) => call("/health", args);
  f.runtime.start = async (args) => {
    await args.authorizeAction({ request_id: "repair_smoke_browse", action: "browse_public_pages", amount_minor: 5 });
    return call("/start", args);
  };
  f.runtime.status = (args) => call("/status", args);
  f.runtime.cancel = (args) => call("/cancel", args);
  const worker = f.make(), running = await worker.dispatch(f.order.id);
  assert.equal(running.state, "running");
  const spent = () => f.service.db.prepare("SELECT spent_minor FROM runs").get().spent_minor;
  assert.equal(spent(), 5);

  f.membership = async (args) => ({ ...await originalMembership(args), expires_at: new Date(f.now() + 10).toISOString() });
  healthAdvance = 11;
  await assert.rejects(worker.authorizeAction(f.order.id, running.job.attempt_id,
    { request_id: "repair_smoke_expired", action: "browse_public_pages", amount_minor: 1 }), { code: "MEMBERSHIP_UNAVAILABLE" });
  assert.equal(spent(), 5);
  healthAdvance = 0; f.membership = originalMembership;

  holdStatus = true;
  const recovering = worker.reconcile(f.order.id);
  await entered.promise;
  assert.equal((await worker.cancel(f.order.id, "operator_stop")).state, "cancelled");
  release.resolve();
  assert.equal((await recovering).state, "cancelled");
  await assert.rejects(worker.authorizeAction(f.order.id, running.job.attempt_id,
    { request_id: "repair_smoke_stopped", action: "browse_public_pages", amount_minor: 1 }), { code: "ACTION_REVOKED" });
  assert.equal(spent(), 5);
  f.reopen();
  assert.equal((await f.make().dispatch(f.order.id)).state, "cancelled");
  console.log(JSON.stringify({ evidence: "LOCAL_EXECUTION_SYNTHETIC_PORTS", mode: "fixture",
    actual_runtime_transport: "loopback_http", runtime_starts: starts, operator_cancellations: cancellations,
    stale_status_after_stop: "cancelled", membership_expiry_during_health: "denied",
    spent_before_races: 5, spent_after_races: spent(), stopped_after_reopen: true,
    provider_or_public_boundary_proof: false }, null, 2));
} finally {
  release.resolve();
  await new Promise((resolve) => server.close(resolve));
  f.close();
}
