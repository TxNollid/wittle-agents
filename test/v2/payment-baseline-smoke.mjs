// Local predecessor smoke, NOT v2/provider acceptance. All credentials/adapters are synthetic.
// Run: node test/v2/payment-baseline-smoke.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../app/whop-payments/server.mjs";

const sources = ["server.mjs", "controller.mjs"];
const hashes = () => Object.fromEntries(sources.map((name) => [name,
  createHash("sha256").update(readFileSync(new URL(`../../app/whop-payments/${name}`, import.meta.url))).digest("hex"),
]));
const before = hashes();
const directory = mkdtempSync(join(tmpdir(), "wittle-qa-baseline-"));
const config = {
  WHOP_COMPANY_ID: "biz_qa_fixture", WHOP_PRODUCT_ID: "prod_qa_fixture",
  WHOP_PLAN_ID: "plan_qa_fixture", WHOP_PRICE: "10.00",
  APP_URL: "http://127.0.0.1", PAYMENTS_SERVICE_TOKEN: "qa-synthetic-operator",
};
let payment;
let checkoutCount = 0;
let checkoutMetadata;
let roomsAvailable = false;
let now = Date.now();
const client = {
  checkoutConfigurations: { async create(input) {
    checkoutCount++;
    checkoutMetadata = input.metadata;
    return { id: "ch_qa_fixture", purchase_url: "https://sandbox.whop.com/checkout/qa-fixture/" };
  } },
  payments: { async retrieve({ id }) {
    assert.equal(id, payment.id);
    return structuredClone(payment);
  } },
};
const rooms = { async ensureProject() {
  if (!roomsAvailable) throw Object.assign(new Error("Synthetic runtime unavailable"), { status: 503 });
  return { project_id: "fixture-project", room_id: "fixture-room", buyer_access: true, seller_access: true };
} };
const service = createService(config, client, join(directory, "db.sqlite"), { rooms, now: () => now });
const checks = [];
const record = (name, actual) => checks.push({ name, status: "PASS", actual });
try {
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const call = async (path, body, token = config.PAYMENTS_SERVICE_TOKEN) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const buyer = (await call("/api/principals", { id: "qa-buyer", role: "buyer", kind: "human" })).body;
  const stranger = (await call("/api/principals", { id: "qa-stranger", role: "buyer", kind: "human" })).body;
  const seller = (await call("/api/principals", { id: "qa-seller", role: "seller", kind: "agent" })).body;
  assert.equal((await call("/api/services", {
    id: "qa-audit", seller_id: seller.id, service_version: "legacy-fixture-1",
    amount_minor: 1000, currency: "usd", account_id: config.WHOP_COMPANY_ID,
    product_id: config.WHOP_PRODUCT_ID, plan_id: config.WHOP_PLAN_ID,
    execution_cap_minor: 500, allowed_actions: ["read_public_pages"],
  })).status, 201);
  const quoteResponse = await call("/api/quotes", {
    service_id: "qa-audit", buyer_id: buyer.id, request_id: "qa-quote-0001",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    scope: {
      title: "Synthetic legacy audit", deliverables: ["Evidence-based findings"],
      acceptance_checks: ["Findings reference inspected pages"], exclusions: ["No site changes"],
      required_inputs: ["Public URL"], revisions: 1, refund_terms: "Synthetic; no funds",
      delivery_timing: "Fixture only", permitted_recipients: [buyer.id, seller.id],
      allowed_actions: ["read_public_pages"],
    },
  }, seller.token);
  assert.equal(quoteResponse.status, 201);
  const quote = quoteResponse.body;
  assert.equal((await call(`/api/quotes/${quote.id}`, undefined, stranger.token)).status, 403);
  const approval = { quote_hash: quote.hash, expected_version: quote.version };
  assert.equal((await call(`/api/quotes/${quote.id}/approve`, approval)).status, 403);
  record("Other buyer read and operator impersonation denied", { other_buyer: 403, operator_approval: 403 });

  // Intentionally exercise the legacy human-approval contract, not fabricated v2 acceptance.
  assert.equal((await call(`/api/quotes/${quote.id}/approve`, approval, buyer.token)).status, 200);
  const checkoutInput = { quote_id: quote.id, quote_hash: quote.hash, request_id: "qa-checkout-0001" };
  const first = await call("/api/checkout", checkoutInput, buyer.token);
  assert.equal(first.status, 201);
  const retry = await call("/api/checkout", checkoutInput, buyer.token);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(checkoutCount, 1);
  const order = first.body;
  record("Checkout retry retains one order", { checkouts: checkoutCount });
  assert.equal((await call(`/api/orders/${order.id}`, undefined, stranger.token)).status, 403);

  payment = {
    id: "pay_qafixture", account_id: config.WHOP_COMPANY_ID,
    product_id: config.WHOP_PRODUCT_ID, plan_id: config.WHOP_PLAN_ID,
    checkout_configuration_id: order.checkout_id, metadata: checkoutMetadata,
    currency: "usd", subtotal: { amount: "10.00", currency: "usd" },
    total: { amount: "10.00", currency: "usd" }, status: "pending", substatus: "pending",
  };
  await service.reconcile(payment.id);
  const count = (table) => service.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  assert.equal(count("fulfillments"), 0);
  payment.status = "paid";
  payment.substatus = "succeeded";
  payment.metadata = { ...checkoutMetadata, environment: "production" };
  await assert.rejects(service.reconcile(payment.id), { status: 422 });
  assert.equal(count("fulfillments"), 0);
  record("Pending and wrong-environment payments cannot fulfill", { receipts: 0 });

  payment.metadata = checkoutMetadata;
  await service.reconcile(payment.id);
  await service.reconcile(payment.id);
  assert.equal(count("fulfillments"), 1);
  assert.equal(count("project_jobs"), 1);
  record("Repeated verified synthetic payment commits one receipt/job", { receipts: 1, provisioning_jobs: 1 });
  assert.equal((await call(`/api/orders/${order.id}/provision`, {})).status, 503);
  assert.equal((await call(`/api/orders/${order.id}`, undefined, buyer.token)).body.workflow_status, "paid_setup_pending");
  record("Unavailable runtime preserves paid pending state", { workflow_status: "paid_setup_pending" });

  roomsAvailable = true;
  assert.equal((await call(`/api/orders/${order.id}/provision`, {})).status, 409);
  now += 1001; // Existing controller fixture convention: advance past retry backoff.
  const provisioned = await call(`/api/orders/${order.id}/provision`, {});
  assert.equal(provisioned.status, 200);
  assert.equal((await call(`/api/orders/${order.id}/readiness`, {
    expected_version: provisioned.body.project.version,
    inputs_ready: true, capacity_ready: true, budget_minor: 500,
  })).status, 200);
  const run = await call(`/api/orders/${order.id}/run`, { request_id: "qa-run-0001" });
  assert.equal(run.status, 200);
  assert.equal((await call(`/api/orders/${order.id}/run`, { request_id: "qa-run-0001" })).body.id, run.body.id);
  assert.equal((await call(`/api/orders/${order.id}/run`, { request_id: "qa-run-0002" })).status, 409);
  record("One local run reservation across retries", { second_logical_run: 409 });

  payment.refunded_at = new Date().toISOString();
  await assert.rejects(service.reconcile(payment.id), { status: 422 });
  assert.equal((await call(`/api/orders/${order.id}`, undefined, buyer.token)).body.payment_status, "refunded");
  assert.equal((await call(`/api/runs/${run.body.id}/reserve-cost`, {
    action: "read_public_pages", request_id: "qa-after-refund", amount_minor: 1,
  })).status, 409);
  assert.equal(count("fulfillments"), 1);
  record("Refund retains receipt and rejects future action", { payment_status: "refunded", future_action: 409, receipts: 1 });
  const after = hashes();
  assert.deepEqual(after, before, "Candidate changed during smoke; results do not pin one candidate");
  console.log(JSON.stringify({
    mode: "LOCAL_PREDECESSOR_SMOKE", node: process.version, checked_at: new Date().toISOString(),
    source_sha256: before, checks,
    provider_purchase: false, actual_audit_dispatch: false, public_release_approved: false,
    limits: ["Legacy USD 10 synthetic approval/provisioning path, not v2 USD 19 payment-as-acceptance",
      "No real Rooms, Whop, hosted audit, private report, revision/rating or credential-boundary proof"],
  }, null, 2));
} finally {
  if (service.server.listening) await new Promise((resolve) => service.server.close(resolve));
  service.close();
  rmSync(directory, { recursive: true, force: true });
}
