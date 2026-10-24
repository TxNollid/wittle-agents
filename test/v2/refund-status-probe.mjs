// Diagnostic, not a provider-shape claim. No real credentials/network/payment.
// Exit 2 means at least one matching adverse synthetic snapshot retained action authority.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../app/whop-payments/server.mjs";

const hash = (file) => createHash("sha256").update(readFileSync(new URL(`../../app/whop-payments/${file}`, import.meta.url))).digest("hex");
const sourceHashes = { server: hash("server.mjs"), controller: hash("controller.mjs") };
const observations = [];
for (const status of ["paid", "pending", "void", "refunded"]) {
  const directory = mkdtempSync(join(tmpdir(), "wittle-qa-refund-"));
  let payment;
  const config = {
    WHOP_COMPANY_ID: "biz_fixture", WHOP_PRODUCT_ID: "prod_fixture", WHOP_PLAN_ID: "plan_fixture",
    WHOP_PRICE: "10.00", APP_URL: "http://127.0.0.1", PAYMENTS_SERVICE_TOKEN: "synthetic-only",
  };
  const client = {
    checkoutConfigurations: { async create() { return { id: "ch_fixture", purchase_url: "https://sandbox.whop.com/checkout/fixture/" }; } },
    payments: { async retrieve() { return structuredClone(payment); } },
  };
  const service = createService(config, client, join(directory, "db.sqlite"), {
    rooms: { async ensureProject() { return { project_id: "fixture_project", room_id: "fixture_room", buyer_access: true, seller_access: true }; } },
  });
  try {
    const c = service.controller;
    const operator = { id: "operator", role: "operator" };
    const buyer = c.register(operator, { id: "buyer", role: "buyer", kind: "human" });
    const seller = c.register(operator, { id: "seller", role: "seller", kind: "agent" });
    c.setService(operator, {
      id: "audit", seller_id: seller.id, service_version: "1", amount_minor: 1000, currency: "usd",
      plan_id: config.WHOP_PLAN_ID, product_id: config.WHOP_PRODUCT_ID, account_id: config.WHOP_COMPANY_ID,
      execution_cap_minor: 500, allowed_actions: ["read_public_pages"],
    });
    const quote = c.propose(seller, {
      service_id: "audit", buyer_id: buyer.id, request_id: "fixture-quote", expires_at: new Date(Date.now() + 60000).toISOString(),
      scope: { title: "Synthetic diagnostic", deliverables: ["Report"], acceptance_checks: ["Evidence"], exclusions: ["No changes"],
        required_inputs: ["Public URL"], revisions: 1, refund_terms: "Synthetic no funds", delivery_timing: "Fixture",
        permitted_recipients: [buyer.id, seller.id], allowed_actions: ["read_public_pages"] },
    });
    c.approve(buyer, quote.id, { quote_hash: quote.hash, expected_version: quote.version });
    const input = { quote_id: quote.id, quote_hash: quote.hash, request_id: "fixture-checkout" };
    const order = await service.checkout(buyer.id, input.request_id, c.checkoutBinding(buyer, input));
    payment = {
      id: "pay_fixture", account_id: config.WHOP_COMPANY_ID, product_id: config.WHOP_PRODUCT_ID, plan_id: config.WHOP_PLAN_ID,
      checkout_configuration_id: order.checkout_id, currency: "usd", subtotal: { amount: "10.00", currency: "usd" },
      total: { amount: "10.00", currency: "usd" }, status: "paid", substatus: "succeeded",
      metadata: { order_id: order.id, environment: "sandbox", quote_hash: quote.hash, buyer_id: buyer.id, seller_id: seller.id, service_version: "1" },
    };
    await service.reconcile(payment.id);
    const provisioned = await c.provision(operator, order.id);
    c.readiness(operator, order.id, { expected_version: provisioned.project.version, inputs_ready: true, capacity_ready: true, budget_minor: 500 });
    const run = c.claimRun(operator, order.id, { request_id: "fixture-run" });
    payment.status = status;
    payment.refunded_at = "2026-10-24T17:00:00.000Z";
    payment.refunded_amount = { amount: "10.00", currency: "usd" };
    let reconcileStatus = "returned";
    try { await service.reconcile(payment.id); } catch (error) { reconcileStatus = error.status; }
    let nextActionAuthorized = false;
    try {
      c.reserveCost(operator, run.id, { action: "read_public_pages", request_id: "fixture-after-refund", amount_minor: 1 });
      nextActionAuthorized = true;
    } catch (error) { assert.equal(error.status, 409); }
    observations.push({ synthetic_top_level_status: status, refund_marker: true, reconcile: reconcileStatus,
      local_payment_status: c.viewOrder(operator, order.id).payment_status, next_action_authorized: nextActionAuthorized });
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
assert.deepEqual({ server: hash("server.mjs"), controller: hash("controller.mjs") }, sourceHashes, "Sources changed during probe");
console.log(JSON.stringify({ mode: "LOCAL_SYNTHETIC_NEGATIVE_STATUS_PROBE", checked_at: new Date().toISOString(),
  source_sha256: sourceHashes, observations,
  provider_shape_verified: false,
  next_action: "Whop owner must confirm actual refund/dispute snapshot shapes and ensure negative evidence is not bypassed by a non-paid top-level status.",
}, null, 2));
if (observations.some((row) => row.next_action_authorized)) process.exitCode = 2;
