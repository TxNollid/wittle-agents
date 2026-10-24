import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createService } from "./server.mjs";
const operator = { id: "operator", role: "operator" };
const config = {
  WHOP_COMPANY_ID: "biz_test",
  WHOP_PRODUCT_ID: "prod_test",
  WHOP_PLAN_ID: "plan_test",
  WHOP_PRICE: "10.00",
  PAYMENTS_SERVICE_TOKEN: "operator-secret",
  WHOP_WEBHOOK_SECRET: "ws_testing",
  APP_URL: "http://localhost:3210",
  EXECUTION_BUDGET_MINOR: "1000",
};
const scope = {
  title: "Audit five public pages",
  deliverables: ["Prioritized findings"],
  acceptance_checks: ["Evidence attached"],
  exclusions: ["No website changes"],
  required_inputs: ["Public URL"],
  revisions: 1,
  refund_terms: "Sandbox test; no real funds",
  delivery_timing: "45 minutes after payment and complete inputs",
  permitted_recipients: ["buyer", "specialist"],
  allowed_actions: ["read_public_pages"],
};
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wittle-controller-"));
  let time = Date.now(),
    checkouts = 0;
  const payments = new Map(),
    created = new Map();
  const client = {
    checkoutConfigurations: {
      async create(input, { idempotencyKey }) {
        if (created.has(idempotencyKey)) return created.get(idempotencyKey);
        checkouts++;
        const v = {
          id: "ch_" + checkouts,
          purchase_url: "https://sandbox.whop.com/checkout/test/",
          input,
        };
        created.set(idempotencyKey, v);
        return v;
      },
    },
    payments: {
      async retrieve({ id }) {
        return payments.get(id);
      },
    },
  };
  const projects = new Map();
  let calls = 0;
  const rooms = {
    async ensureProject(input) {
      calls++;
      if (!projects.has(input.idempotency_key))
        projects.set(input.idempotency_key, {
          project_id: "test_project_" + projects.size,
          room_id: "test_room_" + projects.size,
          buyer_access: true,
          seller_access: true,
        });
      return projects.get(input.idempotency_key);
    },
  };
  const path = join(directory, "db.sqlite");
  const service = createService(config, client, path, {
    now: () => time,
    ...(options.noRooms ? {} : { rooms }),
  });
  const c = service.controller;
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + service.server.address().port;
  const identities = {};
  for (const [id, role, kind] of [
    ["buyer", "buyer", "human"],
    ["other", "buyer", "human"],
    ["agent", "buyer", "agent"],
    ["seller", "seller", "agent"],
  ])
    identities[id] = c.register(operator, { id, role, kind });
  const catalog = c.setService(operator, {
    id: "audit-v1",
    seller_id: "seller",
    service_version: "1",
    amount_minor: 1000,
    currency: "usd",
    plan_id: "plan_test",
    product_id: "prod_test",
    account_id: "biz_test",
    execution_cap_minor: 500,
    allowed_actions: ["read_public_pages"],
  });
  const call = async (path, input, actor = identities.buyer) => {
    const response = await fetch(origin + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization:
          "Bearer " +
          (actor === operator ? config.PAYMENTS_SERVICE_TOKEN : actor.token),
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const propose = (input = {}) =>
    c.propose(identities.seller, {
      request_id: randomUUID(),
      service_id: "audit-v1",
      buyer_id: "buyer",
      scope,
      expires_at: new Date(time + 60000).toISOString(),
      ...input,
    });
  const approve = (q) =>
    c.approve(identities.buyer, q.id, {
      quote_hash: q.hash,
      expected_version: q.version,
    });
  const purchase = async (q, extra = {}) => {
    const result = await call("/api/checkout", {
      quote_id: q.id,
      quote_hash: q.hash,
      request_id: randomUUID(),
      ...extra,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const pay = async (o) => {
    const snapshot = o.quote_snapshot;
    const p = {
      id: "pay_" + randomUUID().replaceAll("-", ""),
      account_id: snapshot.account_id,
      product_id: snapshot.product_id,
      plan_id: snapshot.plan_id,
      checkout_configuration_id: o.checkout_id,
      currency: "usd",
      subtotal: {
        amount: (snapshot.amount_minor / 100).toFixed(2),
        currency: "usd",
      },
      total: {
        amount: (snapshot.amount_minor / 100).toFixed(2),
        currency: "usd",
      },
      status: "paid",
      substatus: "succeeded",
      metadata: {
        order_id: o.id,
        environment: "sandbox",
        quote_hash: o.quote_hash,
        buyer_id: o.buyer_id,
        seller_id: snapshot.seller_id,
        service_version: snapshot.service_version,
      },
    };
    payments.set(p.id, p);
    await service.reconcile(p.id);
    return p;
  };
  const paid = async () => {
    const q = propose();
    approve(q);
    const o = await purchase(q);
    const payment = await pay(o);
    return { q, o, payment };
  };
  const ready = async () => {
    const p = await paid();
    const provisioned = await c.provision(operator, p.o.id);
    const o = c.readiness(operator, p.o.id, {
      expected_version: provisioned.project.version,
      inputs_ready: true,
      capacity_ready: true,
      budget_minor: 500,
    });
    return { ...p, order: o };
  };
  t.after(async () => {
    await new Promise((r) => service.server.close(r));
    service.close();
    rmSync(directory, { recursive: true });
  });
  return {
    ...service,
    c,
    config,
    operator,
    identities,
    catalog,
    scope,
    path,
    client,
    rooms,
    projects,
    payments,
    propose,
    approve,
    purchase,
    pay,
    paid,
    ready,
    call,
    setTime: (value) => (time = value),
    now: () => time,
    checkouts: () => checkouts,
    projectCalls: () => calls,
  };
}
test("checkout rejects missing quote, missing buyer approval, wrong hash, expired and cancelled quotes", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call("/api/checkout", { request_id: randomUUID() })).status,
    409,
  );
  const q = f.propose();
  assert.equal(
    (
      await f.call("/api/checkout", {
        quote_id: q.id,
        quote_hash: q.hash,
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  f.approve(q);
  assert.equal(
    (
      await f.call("/api/checkout", {
        quote_id: q.id,
        quote_hash: "wrong",
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  f.setTime(f.now() + 60001);
  assert.equal(
    (
      await f.call("/api/checkout", {
        quote_id: q.id,
        quote_hash: q.hash,
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(f.checkouts(), 0);
});
test("human and seller approvals bind exact quote hash and version", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  assert.equal(q.approvals.length, 1);
  assert.throws(
    () =>
      f.c.approve(f.identities.buyer, q.id, {
        quote_hash: q.hash,
        expected_version: 2,
      }),
    { status: 409 },
  );
  const approved = f.approve(q);
  assert.equal(approved.approvals.length, 2);
  assert.equal(approved.approvals[0].quote_hash, q.hash);
});
test("an agent without a purchase mandate cannot approve or create checkout", async (t) => {
  const f = await fixture(t);
  const q = f.propose({ buyer_id: "agent" });
  assert.throws(
    () =>
      f.c.approve(f.identities.agent, q.id, {
        quote_hash: q.hash,
        expected_version: 1,
      }),
    { status: 403 },
  );
  assert.equal(
    (
      await f.call(
        "/api/checkout",
        { quote_id: q.id, quote_hash: q.hash, request_id: randomUUID() },
        f.identities.agent,
      )
    ).status,
    403,
  );
});
test("operator token cannot impersonate buyer approval", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  assert.equal(
    (
      await f.call(
        "/api/quotes/" + q.id + "/approve",
        { quote_hash: q.hash, expected_version: 1 },
        operator,
      )
    ).status,
    403,
  );
});
test("another buyer cannot read, approve, cancel or purchase a quote", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  for (const operation of ["approve", "cancel"])
    assert.equal(
      (
        await f.call(
          "/api/quotes/" + q.id + "/" + operation,
          { quote_hash: q.hash, expected_version: 1 },
          f.identities.other,
        )
      ).status,
      403,
    );
  assert.equal(
    (await f.call("/api/quotes/" + q.id, undefined, f.identities.other)).status,
    403,
  );
});
test("quote retries are immutable and preserve the hash", async (t) => {
  const f = await fixture(t);
  const input = { request_id: "quote-retry-key" };
  const q = f.propose(input);
  assert.equal(f.propose(input).id, q.id);
  assert.throws(
    () =>
      f.propose({ ...input, scope: { ...scope, title: "Different scope" } }),
    { status: 409 },
  );
});
test("new quote version invalidates old approvals and checkout; paid scope cannot be rewritten", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  f.approve(q);
  const next = f.propose({
    supersedes: q.id,
    scope: { ...scope, title: "New scoped audit" },
  });
  assert.equal(next.version, 2);
  assert.equal(next.approvals.length, 1);
  assert.equal(
    (
      await f.call("/api/checkout", {
        quote_id: q.id,
        quote_hash: q.hash,
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  f.approve(next);
  const o = await f.purchase(next);
  await f.pay(o);
  assert.throws(
    () =>
      f.propose({
        supersedes: next.id,
        scope: { ...scope, title: "Change paid scope" },
      }),
    { status: 409 },
  );
});
test("concurrent requests for the same approved quote retain one order and checkout", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  f.approve(q);
  const orders = await Promise.all(
    Array.from({ length: 10 }, () => f.purchase(q)),
  );
  assert.equal(new Set(orders.map((o) => o.id)).size, 1);
  assert.equal(f.checkouts(), 1);
});
test("per-order snapshot is verified even after global price changes", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  f.approve(q);
  const o = await f.purchase(q);
  f.config.WHOP_PRICE = "39.00";
  await f.pay(o);
  assert.equal(f.c.viewOrder(operator, o.id).payment_status, "paid");
});
for (const field of ["quote_hash", "buyer_id", "seller_id", "service_version"])
  test(
    "payment with mismatched " + field + " cannot provision project",
    async (t) => {
      const f = await fixture(t);
      const p = await f.paid();
      const payment = {
        ...p.payment,
        id: "pay_wrong" + field.replaceAll("_", ""),
        metadata: { ...p.payment.metadata, [field]: "wrong" },
      };
      f.payments.set(payment.id, payment);
      await assert.rejects(f.reconcile(payment.id), { status: 422 });
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM project_jobs").get().n,
        1,
      );
    },
  );
test("late and cancelled-quote payments are recorded for reconciliation without a project", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  f.approve(q);
  const o = await f.purchase(q);
  f.c.cancel(f.identities.buyer, q.id, {
    quote_hash: q.hash,
    expected_version: 1,
  });
  await f.pay(o);
  const result = f.c.viewOrder(operator, o.id);
  assert.equal(result.payment_status, "paid");
  assert.equal(result.workflow_status, "needs_attention");
  assert.equal(result.project, null);
});
test("expired-quote payment is held even though Whop reports paid", async (t) => {
  const f = await fixture(t);
  const q = f.propose();
  f.approve(q);
  const o = await f.purchase(q);
  f.setTime(f.now() + 60001);
  await f.pay(o);
  assert.equal(
    f.c.viewOrder(operator, o.id).workflow_status,
    "needs_attention",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM project_jobs").get().n,
    0,
  );
});
test("paid state, receipt and provisioning task persist once across duplicate events and database reopen", async (t) => {
  const f = await fixture(t);
  const { o, payment } = await f.paid();
  await f.reconcile(payment.id);
  const reopened = createService(f.config, f.client, f.path, {
    now: f.now,
    rooms: f.rooms,
  });
  assert.equal(
    reopened.controller.viewOrder(operator, o.id).workflow_status,
    "paid_setup_pending",
  );
  assert.equal(
    reopened.db.prepare("SELECT count(*) AS n FROM project_jobs").get().n,
    1,
  );
  reopened.close();
});
test("missing Rooms adapter never reports a ready or running project", async (t) => {
  const f = await fixture(t, { noRooms: true });
  const { o } = await f.paid();
  await assert.rejects(f.c.provision(operator, o.id), { status: 503 });
  assert.equal(
    f.c.viewOrder(operator, o.id).workflow_status,
    "paid_setup_pending",
  );
});
test("Rooms outage retries with one stable provisioning key", async (t) => {
  const f = await fixture(t);
  const { o } = await f.paid();
  const original = f.rooms.ensureProject;
  let keys = [];
  f.rooms.ensureProject = async (input) => {
    keys.push(input.idempotency_key);
    if (keys.length === 1) throw new Error("outage");
    return original(input);
  };
  await assert.rejects(f.c.provision(operator, o.id));
  f.setTime(f.now() + 1001);
  await f.c.provision(operator, o.id);
  assert.equal(new Set(keys).size, 1);
  assert.equal(f.projects.size, 1);
});
test("remote creation followed by lost response reconciles same project on retry", async (t) => {
  const f = await fixture(t);
  const { o } = await f.paid();
  const original = f.rooms.ensureProject;
  let first = true;
  f.rooms.ensureProject = async (input) => {
    const project = await original(input);
    if (first) {
      first = false;
      throw new Error("response lost");
    }
    return project;
  };
  await assert.rejects(f.c.provision(operator, o.id));
  f.setTime(f.now() + 1001);
  await f.c.provision(operator, o.id);
  assert.equal(f.projects.size, 1);
});
test("concurrent provisioning cannot create a second project", async (t) => {
  const f = await fixture(t);
  const { o } = await f.paid();
  const results = await Promise.allSettled([
    f.c.provision(operator, o.id),
    f.c.provision(operator, o.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.projectCalls(), 1);
});
test("failed participant access does not unlock execution", async (t) => {
  const f = await fixture(t);
  const { o } = await f.paid();
  f.rooms.ensureProject = async () => ({
    project_id: "p",
    room_id: "r",
    buyer_access: true,
    seller_access: false,
  });
  await assert.rejects(f.c.provision(operator, o.id), { status: 503 });
  assert.equal(
    f.c.viewOrder(operator, o.id).workflow_status,
    "paid_setup_pending",
  );
});
test("readiness gates inputs, capacity and capped budget before run reservation", async (t) => {
  const f = await fixture(t);
  const { o } = await f.paid();
  let p = await f.c.provision(operator, o.id);
  assert.throws(
    () => f.c.claimRun(operator, o.id, { request_id: randomUUID() }),
    { status: 409 },
  );
  p = f.c.readiness(operator, o.id, {
    expected_version: p.project.version,
    inputs_ready: false,
    capacity_ready: true,
    budget_minor: 500,
  });
  assert.equal(p.workflow_status, "waiting_for_inputs");
  p = f.c.readiness(operator, o.id, {
    expected_version: p.project.version,
    inputs_ready: true,
    capacity_ready: false,
    budget_minor: 500,
  });
  assert.equal(p.workflow_status, "waiting_for_capacity");
  assert.throws(
    () =>
      f.c.readiness(operator, o.id, {
        expected_version: p.project.version,
        inputs_ready: true,
        capacity_ready: true,
        budget_minor: 501,
      }),
    { status: 400 },
  );
});
test("run is leased once, retries reuse it and cost retries cannot overspend", async (t) => {
  const f = await fixture(t);
  const { o } = await f.ready();
  const input = { request_id: randomUUID() };
  const run = f.c.claimRun(operator, o.id, input);
  assert.equal(f.c.claimRun(operator, o.id, input).id, run.id);
  assert.throws(
    () => f.c.claimRun(operator, o.id, { request_id: randomUUID() }),
    { status: 409 },
  );
  f.c.reserveCost(operator, run.id, {
    action: "read_public_pages",
    request_id: "tool-call-one",
    amount_minor: 400,
  });
  f.c.reserveCost(operator, run.id, {
    action: "read_public_pages",
    request_id: "tool-call-one",
    amount_minor: 400,
  });
  assert.throws(
    () =>
      f.c.reserveCost(operator, run.id, {
        action: "read_public_pages",
        request_id: "tool-call-two",
        amount_minor: 101,
      }),
    { status: 409 },
  );
});
test("buyer revocation immediately prevents future work and rejects buyer credentials", async (t) => {
  const f = await fixture(t);
  const { o } = await f.ready();
  const run = f.c.claimRun(operator, o.id, { request_id: randomUUID() });
  f.c.revoke(operator, "buyer");
  assert.throws(
    () =>
      f.c.reserveCost(operator, run.id, {
        action: "read_public_pages",
        request_id: "tool-call-one",
        amount_minor: 1,
      }),
    { status: 409 },
  );
  assert.equal((await f.call("/api/orders/" + o.id)).status, 401);
});
test("refund after payment revokes run and prevents new cost reservations", async (t) => {
  const f = await fixture(t);
  const { o, payment } = await f.ready();
  const run = f.c.claimRun(operator, o.id, { request_id: randomUUID() });
  payment.refunded_at = new Date().toISOString();
  await assert.rejects(f.reconcile(payment.id), { status: 422 });
  assert.equal(f.c.viewOrder(operator, o.id).payment_status, "refunded");
  assert.throws(
    () =>
      f.c.reserveCost(operator, run.id, {
        action: "read_public_pages",
        request_id: "tool-call-one",
        amount_minor: 1,
      }),
    { status: 409 },
  );
});
test("cancel or refund during Rooms provisioning never queues execution", async (t) => {
  const f = await fixture(t);
  const { o, q } = await f.paid();
  const original = f.rooms.ensureProject;
  f.rooms.ensureProject = async (input) => {
    const result = await original(input);
    f.c.cancel(f.identities.buyer, q.id, {
      quote_hash: q.hash,
      expected_version: 1,
    });
    return result;
  };
  await assert.rejects(f.c.provision(operator, o.id), { status: 409 });
  assert.equal(f.c.viewOrder(operator, o.id).workflow_status, "cancelled");
});
test("expired run lease cannot authorize another tool cost", async (t) => {
  const f = await fixture(t);
  const { o } = await f.ready();
  const run = f.c.claimRun(operator, o.id, { request_id: randomUUID() });
  f.setTime(run.lease_until + 1);
  assert.throws(
    () =>
      f.c.reserveCost(operator, run.id, {
        action: "read_public_pages",
        request_id: "tool-call-one",
        amount_minor: 1,
      }),
    { status: 409 },
  );
});
test("run token is scoped to one run, denies admin routes and expires", async (t) => {
  const f = await fixture(t);
  const { o } = await f.ready();
  const run = f.c.claimRun(operator, o.id, { request_id: randomUUID() });
  const worker = f.c.authenticate(run.token);
  assert.equal(worker.role, "worker");
  assert.throws(
    () =>
      f.c.reserveCost(worker, randomUUID(), {
        action: "read_public_pages",
        request_id: "wrong-run-key",
        amount_minor: 1,
      }),
    { status: 403 },
  );
  assert.equal(
    (await f.call("/api/services", {}, { token: run.token })).status,
    403,
  );
  const r = await f.call(
    "/api/runs/" + run.id + "/reserve-cost",
    {
      action: "read_public_pages",
      request_id: "scoped-run-key",
      amount_minor: 1,
    },
    { token: run.token },
  );
  assert.equal(r.status, 200);
  f.setTime(run.lease_until + 1);
  assert.equal(f.c.authenticate(run.token), null);
});
test("accepted scope does not authorize publishing actions", async (t) => {
  const f = await fixture(t);
  const { o } = await f.ready();
  const run = f.c.claimRun(operator, o.id, { request_id: randomUUID() });
  assert.throws(
    () =>
      f.c.reserveCost(f.c.authenticate(run.token), run.id, {
        action: "publish_website",
        request_id: "forbidden-action",
        amount_minor: 1,
      }),
    { status: 403 },
  );
});
test("another buyer cannot read a paid order or confirm its payment", async (t) => {
  const f = await fixture(t);
  const { o, payment } = await f.paid();
  assert.equal(
    (await f.call("/api/orders/" + o.id, undefined, f.identities.other)).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/api/orders/" + o.id + "/confirm",
        { payment_id: payment.id },
        f.identities.other,
      )
    ).status,
    403,
  );
});
test("owner budget exhaustion prevents a new run even when project is ready", async (t) => {
  const f = await fixture(t);
  const { o } = await f.ready();
  f.db
    .prepare("UPDATE execution_budget SET allowance_minor=499 WHERE id=1")
    .run();
  assert.throws(
    () => f.c.claimRun(operator, o.id, { request_id: randomUUID() }),
    { status: 409 },
  );
});
test("seller quote cannot add an action outside operator policy", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.propose({ scope: { ...scope, allowed_actions: ["publish_website"] } }),
    { status: 403 },
  );
});
test("durable project worker consumes one paid task and ignores subsequent drains", async (t) => {
  const f = await fixture(t);
  const { o } = await f.paid();
  await f.drainProjects();
  await f.drainProjects();
  assert.equal(
    f.c.viewOrder(operator, o.id).workflow_status,
    "waiting_for_inputs",
  );
  assert.equal(f.projects.size, 1);
  assert.equal(f.projectCalls(), 1);
});
test("signed refund event reconciles authoritative payment and revokes future work", async (t) => {
  const f = await fixture(t);
  const { o, payment } = await f.ready();
  const run = f.c.claimRun(operator, o.id, { request_id: randomUUID() });
  payment.refunded_at = new Date().toISOString();
  const event = {
      id: "msg_" + randomUUID(),
      type: "refund.created",
      data: { payment_id: payment.id },
    },
    raw = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", config.WHOP_WEBHOOK_SECRET)
    .update(event.id + "." + timestamp + "." + raw)
    .digest("base64");
  const r = await fetch(
    "http://127.0.0.1:" + f.server.address().port + "/api/webhooks/whop",
    {
      method: "POST",
      body: raw,
      headers: {
        "webhook-id": event.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": "v1," + signature,
      },
    },
  );
  assert.equal(r.status, 200);
  await f.drain();
  assert.equal(f.c.viewOrder(operator, o.id).payment_status, "refunded");
  assert.equal(f.c.authenticate(run.token), null);
});
