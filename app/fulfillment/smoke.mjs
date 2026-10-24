// Actual controller + SQLite + loopback runtime; every provider, identity and readiness fact is synthetic.
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

const f = await fixture();
const runs = new Map();
let starts = 0, cancellations = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const args = JSON.parse(Buffer.concat(chunks).toString());
  if (request.url === "/start") {
    starts++;
    runs.set(args.request_id, f.receipt(args, "running"));
    // The remote run exists, but its first acknowledgement is deliberately lost.
    request.socket.destroy();
    return;
  }
  if (request.url === "/cancel") {
    cancellations++;
    runs.set(args.request_id, f.receipt(args, "cancelled"));
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(runs.get(args.request_id) || f.receipt(args, "unknown")));
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const call = async (path, { job, request_id, signal }) => {
    const response = await fetch(origin + path, { method: "POST", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job, request_id }) });
    return response.json();
  };
  f.runtime.start = async (args) => {
    await args.authorizeAction({ request_id: "smoke_browse_0001", action: "browse_public_pages", amount_minor: 5 });
    return call("/start", args);
  };
  f.runtime.status = (args) => call("/status", args);
  f.runtime.cancel = (args) => call("/cancel", args);
  let worker = f.make();
  const first = await worker.drain();
  assert.equal(first[0].reason, "unknown_start_outcome");
  assert.equal(starts, 1);
  f.reopen(); worker = f.make();
  await worker.dispatch(f.order.id);
  assert.equal(starts, 1);
  const recovered = await worker.reconcile(f.order.id);
  assert.equal(recovered.state, "running");
  assert.equal(recovered.job.room_id, f.quote.offer.room_id);
  assert.equal(recovered.job.quote_hash, f.quote.quote_hash);
  await assert.rejects(f.refund(), { status: 422 });
  await worker.drain();
  assert.equal(worker.inspect(f.order.id).state, "cancelled");
  await assert.rejects(worker.authorizeAction(f.order.id, recovered.job.attempt_id,
    { request_id: "smoke_after_refund", action: "browse_public_pages", amount_minor: 1 }), { code: "ACTION_REVOKED" });
  assert.equal(cancellations, 1);
  console.log(JSON.stringify({ evidence: "LOCAL_EXECUTION_SYNTHETIC_PORTS", mode: "fixture",
    buyer_followup_messages: 0, runtime_starts: starts, unknown_ack_persisted: true,
    reopen_replay_starts: 0, exact_room_hash_preserved: true, reconciled_existing_attempt: true,
    simulated_refund_cancellations: cancellations, post_refund_action: "denied",
    completed_provider_purchase: false, real_room_or_audit: false, public_runtime_boundary_proved: false }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  f.close();
}
