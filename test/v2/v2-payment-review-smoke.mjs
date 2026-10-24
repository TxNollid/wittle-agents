// Diagnostic smoke of real local gateway/controller state; no external provider calls.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixture, admin } from "./payment-review-fixture.mjs";
import { projectPublicStats } from "../../app/stats/index.mjs";
const files = ["whop-payments/server.mjs", "whop-payments/controller.mjs", "whop-payments/v2.mjs", "stats/index.mjs"];
const hashes = () => Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(new URL(`../../app/${file}`, import.meta.url))).digest("hex")]));
const sourceBefore = hashes(), observations = {};
const unknown = fixture();
try {
  let status = "returned";
  try { await unknown.quote(JSON.parse('{"constructor":{"buyer_id":"other"},"__proto__":{"room_id":"other"}}')); }
  catch (error) { status = error.status || "error"; }
  observations.unknown_fields = { outcome: status, provider_create_calls: unknown.state.createCalls };
} finally { unknown.close(); }
const revoked = fixture();
try {
  revoked.state.onCreate = async () => { throw new Error("Synthetic outage"); };
  try { await revoked.quote(); } catch { /* Deliberate provider failure. */ }
  const before = revoked.state.createCalls;
  revoked.c.revoke(admin, revoked.template.seller_id);
  revoked.state.onCreate = null;
  let status = "returned";
  try { await revoked.quote(); } catch (error) { status = error.status || "error"; }
  observations.revoked_retry = { outcome: status, new_provider_create_calls: revoked.state.createCalls - before };
} finally { revoked.close(); }
const financial = fixture();
try {
  const q = await financial.quote();
  await financial.service.reconcile(financial.payment(q).id);
  const paid = projectPublicStats(financial.service.paymentSnapshot(), new Date(financial.now()));
  await financial.service.reconcile(financial.payment(q, { status: "pending", substatus: "pending" }).id);
  const pending = projectPublicStats(financial.service.paymentSnapshot(), new Date(financial.now()));
  observations.paid_then_pending = { before: { paid_orders: paid.counts.paid_orders, gross_minor: paid.revenue.sandbox.gross_minor },
    after: { paid_orders: pending.counts.paid_orders, gross_minor: pending.revenue.sandbox.gross_minor }, buyer_payment_status: (await financial.status(q)).payment_status };
  try { await financial.service.reconcile(financial.payment(q, { refunded_at: new Date(financial.now()).toISOString() }).id); }
  catch (error) { if (error.status !== 422) throw error; }
  const refundBefore = (await financial.status(q)).refund_status;
  await financial.service.reconcile(financial.payment(q).id);
  const final = await financial.status(q);
  observations.refund_then_stale_success = { before: refundBefore, after: final.refund_status, work_state: final.state };
} finally { financial.close(); }
const sourceAfter = hashes();
const unchanged = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
console.log(JSON.stringify({ mode: "LOCAL_SYNTHETIC_V2_REVIEW", checked_at: new Date().toISOString(), source_before: sourceBefore,
  source_after: sourceAfter, unchanged_candidate: unchanged, observations, provider_purchase: false, release_approved: false }, null, 2));
if (!unchanged) process.exitCode = 2;
