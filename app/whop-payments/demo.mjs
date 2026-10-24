// A fully local contract demo: real HTTP, signatures and SQLite; simulated Whop and Rooms.
import { createService } from "./server.mjs";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const directory = mkdtempSync(join(tmpdir(), "wittle-flow-demo-"));
const config = {
  WHOP_COMPANY_ID: "biz_demo",
  WHOP_PRODUCT_ID: "prod_demo",
  WHOP_PLAN_ID: "plan_demo",
  WHOP_PRICE: "10.00",
  APP_URL: "http://localhost:3210",
  PAYMENTS_SERVICE_TOKEN: "demo-operator-token",
  WHOP_WEBHOOK_SECRET: "ws_demo_secret",
};
let checkoutRequest, payment;
const projects = new Map();
const whop = {
  checkoutConfigurations: {
    async create(input) {
      checkoutRequest = input;
      return {
        id: "ch_demo",
        purchase_url: "https://sandbox.whop.com/checkout/demo/",
      };
    },
  },
  payments: {
    async retrieve() {
      return payment;
    },
  },
};
const rooms = {
  async ensureProject(input) {
    if (!projects.has(input.idempotency_key))
      projects.set(input.idempotency_key, {
        project_id: "SIMULATED_PROJECT",
        room_id: "SIMULATED_ROOM",
        buyer_access: true,
        seller_access: true,
      });
    return projects.get(input.idempotency_key);
  },
};
const service = createService(config, whop, join(directory, "db.sqlite"), {
  rooms,
});
await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + service.server.address().port;
const trace = [];
const call = async (path, body, token = config.PAYMENTS_SERVICE_TOKEN) => {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
};
const step = (name, evidence) => {
  trace.push({ step: name, ...evidence });
  console.log(name + ": " + JSON.stringify(evidence));
};
try {
  const buyer = (
    await call("/api/principals", {
      id: "demo-buyer",
      role: "buyer",
      kind: "human",
    })
  ).body;
  const seller = (
    await call("/api/principals", {
      id: "demo-specialist",
      role: "seller",
      kind: "agent",
    })
  ).body;
  await call("/api/services", {
    id: "demo-auditor-v1",
    seller_id: seller.id,
    service_version: "v1",
    amount_minor: 1000,
    currency: "usd",
    account_id: "biz_demo",
    product_id: "prod_demo",
    plan_id: "plan_demo",
    execution_cap_minor: 500,
    allowed_actions: ["read_public_pages"],
  });
  const scope = {
    title: "Sandbox website audit",
    deliverables: ["Prioritized findings with evidence"],
    acceptance_checks: ["Each finding references a reviewed public page"],
    exclusions: ["No website changes"],
    required_inputs: ["Approved public website URL"],
    revisions: 1,
    refund_terms: "Sandbox demonstration; no actual funds",
    delivery_timing: "45 minutes after payment and complete inputs",
    permitted_recipients: [buyer.id, seller.id],
    allowed_actions: ["read_public_pages"],
  };
  const q = (
    await call(
      "/api/quotes",
      {
        service_id: "demo-auditor-v1",
        buyer_id: buyer.id,
        request_id: randomUUID(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        scope,
      },
      seller.token,
    )
  ).body;
  step("Seller proposes immutable scope", {
    quote_id: q.id,
    quote_hash: q.hash,
    seller_approvals: q.approvals.length,
  });
  const input = {
    quote_id: q.id,
    quote_hash: q.hash,
    request_id: randomUUID(),
  };
  const denied = await call("/api/checkout", input, buyer.token);
  assert.equal(denied.status, 409);
  step("Unapproved checkout blocked", { http_status: denied.status });
  await call(
    "/api/quotes/" + q.id + "/approve",
    { quote_hash: q.hash, expected_version: q.version },
    buyer.token,
  );
  step("Simulated human buyer approves exact quote", { quote_hash: q.hash });
  const order = (await call("/api/checkout", input, buyer.token)).body;
  assert.equal(order.workflow_status, "awaiting_payment");
  step("Bound checkout", {
    order_id: order.id,
    quote_hash: checkoutRequest.metadata.quote_hash,
    state: order.workflow_status,
  });
  payment = {
    id: "pay_demo",
    account_id: "biz_demo",
    product_id: "prod_demo",
    plan_id: "plan_demo",
    checkout_configuration_id: "ch_demo",
    metadata: checkoutRequest.metadata,
    currency: "usd",
    subtotal: { amount: "10.00", currency: "usd" },
    total: { amount: "10.00", currency: "usd" },
    status: "paid",
    substatus: "succeeded",
  };
  const send = async (type, data) => {
    const event = {
        id: "msg_" + randomUUID(),
        type,
        account_id: "biz_demo",
        data,
      },
      raw = JSON.stringify(event),
      timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", config.WHOP_WEBHOOK_SECRET)
      .update(event.id + "." + timestamp + "." + raw)
      .digest("base64");
    const r = await fetch(origin + "/api/webhooks/whop", {
      method: "POST",
      body: raw,
      headers: {
        "webhook-id": event.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": "v1," + signature,
      },
    });
    assert.equal(r.status, 200);
    await service.drain();
  };
  await send("payment.succeeded", payment);
  let current = (await call("/api/orders/" + order.id, undefined, buyer.token))
    .body;
  assert.equal(current.workflow_status, "paid_setup_pending");
  step("Signed payment queues project atomically", {
    state: current.workflow_status,
    project_jobs: service.db
      .prepare("SELECT count(*) AS n FROM project_jobs")
      .get().n,
  });
  const p = await call("/api/orders/" + order.id + "/provision", {});
  assert.equal(p.status, 200);
  current = p.body;
  step("Simulated Rooms project reconciled", {
    project_id: current.project.project_id,
    state: current.workflow_status,
  });
  current = (
    await call("/api/orders/" + order.id + "/readiness", {
      expected_version: current.project.version,
      inputs_ready: true,
      capacity_ready: true,
      budget_minor: 500,
    })
  ).body;
  assert.equal(current.workflow_status, "ready");
  step("Execution prerequisites satisfied", {
    state: current.workflow_status,
    budget_minor: current.project.budget_minor,
  });
  const runInput = { request_id: randomUUID() },
    run = (await call("/api/orders/" + order.id + "/run", runInput)).body;
  const replay = (await call("/api/orders/" + order.id + "/run", runInput))
    .body;
  assert.equal(run.id, replay.id);
  step("One scoped run reserved across retries", {
    run_id: run.id,
    duplicate_run_created: false,
  });
  const cost = await call("/api/runs/" + run.id + "/reserve-cost", {
    action: "read_public_pages",
    request_id: "demo-tool-one",
    amount_minor: 100,
  });
  assert.equal(cost.status, 200);
  step("Tool cost reserved inside cap", { amount_minor: 100 });
  payment.refunded_at = new Date().toISOString();
  payment.refunded_amount = { amount: "10.00", currency: "usd" };
  await send("refund.created", { payment_id: payment.id });
  const blocked = await call("/api/runs/" + run.id + "/reserve-cost", {
    action: "read_public_pages",
    request_id: "demo-tool-two",
    amount_minor: 100,
  });
  assert.equal(blocked.status, 409);
  step("Refund stops future work", {
    payment_status: (
      await call("/api/orders/" + order.id, undefined, buyer.token)
    ).body.payment_status,
    next_cost_http_status: blocked.status,
  });
  const report = {
    checked_at: new Date().toISOString(),
    mode: "LOCAL_SIMULATION",
    external_payment_submitted: false,
    real_rooms_project_created: false,
    real_specialist_executed: false,
    trace,
  };
  writeFileSync(
    new URL("../../sandbox/whop-controller-demo.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  await new Promise((r) => service.server.close(r));
  service.close();
  rmSync(directory, { recursive: true });
}
