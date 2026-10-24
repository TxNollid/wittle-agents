import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WhopClient, WhopEnvironment } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import { createController } from "./controller.mjs";
import { createV2Adapter } from "./v2.mjs";
import { createLifecycle } from "./lifecycle.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export function loadConfig() {
  try {
    process.loadEnvFile(resolve(root, ".env.local"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const e = process.env;
  for (const key of [
    "WHOP_COMPANY_API_KEY",
    "WHOP_COMPANY_ID",
    "WHOP_PRODUCT_ID",
    "WHOP_PLAN_ID",
    "PAYMENTS_SERVICE_TOKEN",
    "WHOP_SANDBOX",
    "APP_URL",
  ])
    if (!e[key]) throw new Error(`Missing ${key}`);
  // Production requires a separate review of account, catalog and fulfillment configuration.
  if (e.WHOP_SANDBOX !== "true")
    throw new Error("This test service requires WHOP_SANDBOX=true.");
  if (!/^https?:\/\//.test(e.APP_URL))
    throw new Error("APP_URL must be an absolute HTTP(S) URL.");
  return { ...e, WHOP_PRICE: e.WHOP_PRICE || "10.00", WHOP_CURRENCY: "usd" };
}
export function makeClient(config) {
  return new WhopClient({
    token: config.WHOP_COMPANY_API_KEY,
    environment: WhopEnvironment.Sandbox,
    apiVersionDate: "2026-10-24",
    timeoutInSeconds: 15,
    maxRetries: 1,
  });
}
const fail = (status, message) => Object.assign(new Error(message), { status });
export function cents(money) {
  if (
    !money ||
    money.currency !== "usd" ||
    !/^\d+(\.\d{1,2})?$/.test(money.amount)
  )
    throw fail(422, "Invalid USD amount");
  const [whole, part = ""] = money.amount.split(".");
  return BigInt(whole) * 100n + BigInt(part.padEnd(2, "0"));
}
export function createService(
  config,
  client = makeClient(config),
  dbPath = resolve(root, ".payments/payments.sqlite"),
  adapters = {},
) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, buyer_id TEXT NOT NULL, status TEXT NOT NULL, checkout_id TEXT UNIQUE, purchase_url TEXT, payment_id TEXT UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS fulfillments (order_id TEXT PRIMARY KEY, payment_id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const controller = createController(db, config, adapters);
  Object.assign(controller,createLifecycle({db,controller,config,options:adapters.lifecycle,now:adapters.now}));
  const getOrder = (id) =>
    db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  const locks = new Map();
  const v2 = createV2Adapter({db,controller,checkout,config,options:adapters.v2,now:adapters.now});
  // Internal payment primitive. Public checkout is guarded by controller.checkoutBinding.
  async function checkout(buyerId, requestId, binding) {
    if (
      !buyerId ||
      typeof buyerId !== "string" ||
      buyerId.length > 200 ||
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)
    )
      throw fail(
        400,
        "buyer_id and request_id (8–100 letters, numbers, _ or -) required",
      );
    if (locks.has(requestId)) {
      const active = locks.get(requestId);
      if (active.buyerId !== buyerId || active.quoteId !== binding?.row.id)
        throw fail(409, "Request ID already used");
      return active.task;
    }
    const task = (async () => {
      let order = db
        .prepare("SELECT * FROM orders WHERE request_id=?")
        .get(requestId);
      if (
        order &&
        (order.buyer_id !== buyerId ||
          order.quote_id !== (binding?.row.id || null))
      )
        throw fail(409, "Request ID already used");
      if (!order && binding)
        order = db
          .prepare("SELECT * FROM orders WHERE quote_id=?")
          .get(binding.row.id);
      if (!order) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO orders (id,request_id,buyer_id,status,created_at) VALUES (?,?,?,?,?)",
        ).run(id, requestId, buyerId, "pending", new Date().toISOString());
        if (binding)
          db.prepare(
            "UPDATE orders SET quote_id=?,quote_hash=?,quote_snapshot=?,workflow_status='awaiting_payment' WHERE id=?",
          ).run(binding.row.id, binding.row.hash, binding.row.snapshot, id);
        order = getOrder(id);
      }
      if (order.purchase_url) return order;
      const result = await client.checkoutConfigurations.create(
        {
          account_id: binding?.snapshot.account_id || config.WHOP_COMPANY_ID,
          plan_id: binding?.snapshot.plan_id || config.WHOP_PLAN_ID,
          mode: "payment",
          metadata: {
            order_id: order.id,
            environment: "sandbox",
            ...(binding
              ? {
                  quote_hash: binding.row.hash,
                  buyer_id: buyerId,
                  seller_id: binding.row.seller_id,
                  service_version: binding.snapshot.service_version,
                }
              : {}),
          },
          redirect_url: binding?.snapshot.return_url || new URL("/checkout-complete", config.APP_URL).href,
        },
        { idempotencyKey: order.id },
      );
      const url = new URL(result.purchase_url);
      if (url.protocol !== "https:" || url.hostname !== "sandbox.whop.com")
        throw fail(502, "Unexpected checkout host");
      db.prepare(
        "UPDATE orders SET checkout_id=?,purchase_url=? WHERE id=?",
      ).run(result.id, result.purchase_url, order.id);
      return getOrder(order.id);
    })();
    locks.set(requestId, { buyerId, quoteId: binding?.row.id, task });
    try {
      return await task;
    } finally {
      locks.delete(requestId);
    }
  }
  async function reconcile(paymentId, expectedOrderId) {
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId || ""))
      throw fail(422, "Invalid payment ID");
    const payment = await client.payments.retrieve({ id: paymentId });
    const order = getOrder(payment.metadata?.order_id || "");
    if (!order || (expectedOrderId && order.id !== expectedOrderId))
      throw fail(422, "Payment order mismatch");
    const agreed = order.quote_snapshot
      ? JSON.parse(order.quote_snapshot)
      : null;
    if (
      payment.id !== paymentId ||
      payment.account_id !== (agreed?.account_id || config.WHOP_COMPANY_ID) ||
      payment.product_id !== (agreed?.product_id || config.WHOP_PRODUCT_ID) ||
      payment.plan_id !== (agreed?.plan_id || config.WHOP_PLAN_ID) ||
      payment.checkout_configuration_id !== order.checkout_id ||
      payment.metadata?.environment !== "sandbox" ||
      payment.currency !== "usd"
    )
      throw fail(422, "Payment context mismatch");
    if (
      agreed &&
      (payment.metadata?.quote_hash !== order.quote_hash ||
        payment.metadata?.buyer_id !== order.buyer_id ||
        payment.metadata?.seller_id !== agreed.seller_id ||
        payment.metadata?.service_version !== agreed.service_version)
    )
      throw fail(422, "Payment agreement mismatch");
    if (
      cents(payment.subtotal) !==
        (agreed
          ? BigInt(agreed.amount_minor)
          : cents({ amount: config.WHOP_PRICE, currency: "usd" })) ||
      cents(payment.total) < cents(payment.subtotal)
    )
      throw fail(422, "Payment amount mismatch");
    const amountMinor = Number(cents(payment.total));
    const refundedMinor = payment.refunded_amount ? Number(cents(payment.refunded_amount)) : 0;
    if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(refundedMinor) || refundedMinor < 0 || refundedMinor > amountMinor) throw fail(422,"Invalid provider refund amount");
    const disputed = /disput/.test(payment.substatus || "");
    const receipt = {payment_id:payment.id,order_id:order.id,environment:"sandbox",customer_classification:"unknown",gross_minor:amountMinor,refunded_minor:refundedMinor,refund_status:refundedMinor ? (refundedMinor>=amountMinor ? "full":"partial") : /refund/.test(payment.substatus || "") || payment.refunded_at ? "pending":"none",dispute_status:disputed ? (/dispute_won/.test(payment.substatus)?"won":/dispute_lost/.test(payment.substatus)?"lost":"open"):"none",state:disputed ? "disputed" : refundedMinor || payment.refunded_at || /refund/.test(payment.substatus || "") ? "refunded" : payment.status === "paid" ? "paid" : (["failed","void","uncollectible"].includes(payment.status) || ["failed","blocked","canceled","uncollectible"].includes(payment.substatus)) ? "failed" : "pending",at:new Date((adapters.now || Date.now)()).toISOString()};
    if (payment.status !== "paid" && !disputed && receipt.state !== "refunded") {
      controller.transaction(()=> {
        controller.recordReceipt(receipt);
        if (!order.payment_id && receipt.state === "failed") db.prepare("UPDATE orders SET payment_status='failed' WHERE id=?").run(order.id);
      });
      return getOrder(order.id);
    }
    if (
      payment.refunded_at ||
      (payment.refunded_amount && cents(payment.refunded_amount) > 0n) ||
      /refund|disput/.test(payment.substatus || "")
    ) {
      controller.adversePayment(
        order.id,
        /disput/.test(payment.substatus || "") ? "disputed" : "refunded",
        receipt,
      );
      throw fail(422, "Payment refunded or disputed");
    }
    if (order.payment_id && order.payment_id !== payment.id) {
      controller.adversePayment(order.id,"duplicate_payment",receipt);
      throw fail(409,"Additional payment requires operator resolution");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = getOrder(order.id);
      controller.recordReceipt(receipt);
      if (existing.payment_id && existing.payment_id !== payment.id)
        throw fail(409, "Order already paid with another payment");
      db.prepare("UPDATE orders SET status='paid',payment_id=? WHERE id=?").run(
        payment.id,
        order.id,
      );
      // Durable sandbox receipt. A future worker can consume this row for actual delivery.
      db.prepare(
        "INSERT OR IGNORE INTO fulfillments VALUES (?,?,'sandbox_receipt',?)",
      ).run(order.id, payment.id, new Date().toISOString());
      controller.paymentRecorded(getOrder(order.id));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return getOrder(order.id);
  }
  let processing = false;
  async function drain() {
    if (processing) return;
    processing = true;
    try {
      for (const row of db
        .prepare(
          "SELECT * FROM events WHERE status='pending' AND retry_at<=? LIMIT 20",
        )
        .all(Date.now())) {
        try {
          const event = JSON.parse(row.payload);
          if (
            event.type === "payment.succeeded" ||
            event.type === "payment.failed"
          ) {
            // Unrelated test or dashboard payments have no local order; acknowledge without fulfillment.
            if (getOrder(event.data?.metadata?.order_id || "")) {
              const account =
                event.account_id ??
                event.company_id ??
                event.data.account_id ??
                event.data.company?.id;
              if (account !== config.WHOP_COMPANY_ID)
                throw fail(422, "Event account mismatch");
              const order = await reconcile(event.data.id);
              if (event.type === "payment.succeeded" && order.status !== "paid")
                throw new Error("Payment not settled yet");
            }
          }
          if (/^(refund|dispute)\.(created|updated)$/.test(event.type)) {
            const paymentId = event.data.payment_id || event.data.payment?.id;
            const affected =
              typeof paymentId === "string" &&
              db
                .prepare("SELECT id FROM orders WHERE payment_id=?")
                .get(paymentId);
            if (affected) {
              try {
                await reconcile(paymentId, affected.id);
              } catch (e) {
                if (e.message !== "Payment refunded or disputed") throw e;
              }
            }
          }
          db.prepare("UPDATE events SET status='processed' WHERE id=?").run(
            row.id,
          );
        } catch (e) {
          if (e.status >= 400 && e.status < 500)
            db.prepare("UPDATE events SET status='rejected' WHERE id=?").run(
              row.id,
            );
          else
            db.prepare(
              "UPDATE events SET attempts=attempts+1,retry_at=? WHERE id=?",
            ).run(
              Date.now() +
                Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8)),
              row.id,
            );
        }
      }
    } finally {
      processing = false;
    }
  }
  const token = Buffer.from(config.PAYMENTS_SERVICE_TOKEN);
  let provisioning = false;
  async function drainProjects() {
    if (provisioning || !adapters.rooms) return;
    provisioning = true;
    try {
      const clock = adapters.now ? adapters.now() : Date.now();
      const pending = db
        .prepare(
          "SELECT j.order_id FROM project_jobs j JOIN orders o ON o.id=j.order_id WHERE j.status IN ('pending','provisioning') AND j.retry_at<=? AND j.lease_until<=? AND o.workflow_status='paid_setup_pending' AND o.payment_status='paid' LIMIT 10",
        )
        .all(clock, clock);
      for (const job of pending) {
        try {
          await controller.provision(
            { id: "project-worker", role: "operator" },
            job.order_id,
          );
        } catch {
          /* The durable job retains its retry state; never claim project readiness. */
        }
      }
    } finally {
      provisioning = false;
    }
  }
  function authorized(req) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(header.slice(7));
    return supplied.length === token.length && timingSafeEqual(supplied, token);
  }
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) throw fail(413, "Body too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/health")
        return send(200, {
          environment: "sandbox",
          webhookConfigured: Boolean(config.WHOP_WEBHOOK_SECRET),
        });
      if (req.method === "GET" && path === "/checkout-complete")
        return send(200, {
          message:
            "Checkout returned. Your order is confirmed separately by a verified payment webhook.",
        });
      if (req.method === "POST" && path === "/api/webhooks/whop") {
        if (!config.WHOP_WEBHOOK_SECRET)
          throw fail(503, "Webhook secret not configured");
        const raw = await body(req);
        let event;
        try {
          event = unwrapWebhook(raw, {
            headers: req.headers,
            key: config.WHOP_WEBHOOK_SECRET,
          });
        } catch {
          throw fail(401, "Invalid signature");
        }
        if (
          !event ||
          event.id !== req.headers["webhook-id"] ||
          typeof event.type !== "string" ||
          !event.data
        )
          throw fail(400, "Invalid event");
        db.prepare(
          "INSERT OR IGNORE INTO events (id,payload) VALUES (?,?)",
        ).run(event.id, raw);
        send(200, { received: true });
        void drain();
        return;
      }
      const credential = (req.headers.authorization || "").startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null;
      const actor = authorized(req)
        ? { id: "operator", role: "operator" }
        : credential
          ? controller.authenticate(credential)
          : null;
      if (!actor) throw fail(401, "Unauthorized");
      const readInput = async () => {
        const input = JSON.parse(await body(req));
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw fail(400, "Expected a JSON object");
        return input;
      };
      if (req.method === "GET" && path === "/api/payment-snapshot") {
        if (actor.role !== "operator") throw fail(403,"Operator access required");
        return send(200,controller.paymentSnapshot());
      }
      if (req.method === "POST" && path === "/api/principals")
        return send(201, controller.register(actor, await readInput()));
      if (req.method === "POST" && path === "/api/services")
        return send(201, controller.setService(actor, await readInput()));
      if (req.method === "POST" && path === "/api/quotes")
        return send(201, controller.propose(actor, await readInput()));
      const quotePath = path.match(
        /^\/api\/quotes\/([a-f0-9-]{36})(\/(approve|cancel))?$/,
      );
      if (quotePath) {
        if (req.method === "GET" && !quotePath[2])
          return send(200, controller.viewQuote(actor, quotePath[1]));
        if (req.method === "POST" && quotePath[3] === "approve")
          return send(
            200,
            controller.approve(actor, quotePath[1], await readInput()),
          );
        if (req.method === "POST" && quotePath[3] === "cancel")
          return send(
            200,
            controller.cancel(actor, quotePath[1], await readInput()),
          );
      }
      const revokePath = path.match(/^\/api\/principals\/([^/]+)\/revoke$/);
      if (req.method === "POST" && revokePath)
        return send(
          200,
          controller.revoke(actor, decodeURIComponent(revokePath[1])),
        );
      if (req.method === "POST" && path === "/api/checkout") {
        const input = await readInput();
        const binding = controller.checkoutBinding(actor, input);
        const order = await checkout(actor.id, input.request_id, binding);
        controller.checkoutBinding(actor, input); // Recheck cancellation, expiry and revocation after external I/O.
        return send(201, controller.viewOrder(actor, order.id));
      }
      const jobPath = path.match(
        /^\/api\/orders\/([a-f0-9-]{36})\/(provision|readiness|run)$/,
      );
      if (req.method === "POST" && jobPath) {
        if (jobPath[2] === "provision")
          return send(200, await controller.provision(actor, jobPath[1]));
        const input = await readInput();
        return send(
          200,
          jobPath[2] === "readiness"
            ? controller.readiness(actor, jobPath[1], input)
            : controller.claimRun(actor, jobPath[1], input),
        );
      }
      const costPath = path.match(
        /^\/api\/runs\/([a-f0-9-]{36})\/reserve-cost$/,
      );
      if (req.method === "POST" && costPath)
        return send(
          200,
          controller.reserveCost(actor, costPath[1], await readInput()),
        );
      const match = path.match(/^\/api\/orders\/([a-f0-9-]{36})(\/confirm)?$/);
      if (match && req.method === "GET" && !match[2])
        return send(200, controller.viewOrder(actor, match[1]));
      if (match && req.method === "POST" && match[2]) {
        controller.viewOrder(actor, match[1]);
        const input = await readInput();
        await reconcile(input.payment_id, match[1]);
        return send(200, controller.viewOrder(actor, match[1]));
      }
      throw fail(404, "Not found");
    } catch (e) {
      send(e.status || (e instanceof SyntaxError ? 400 : 502), {
        error: e.status ? e.message : "Payment service request failed",
      });
    }
  });
  // Optional recovery: account-scoped discovery plus rotating known-payment reads.
  // One page/at most ten detail reads per sweep; no unbounded pagination or auto-refund.
  db.exec("CREATE TABLE IF NOT EXISTS payment_recovery (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT, payment_cursor TEXT)");
  db.prepare("INSERT OR IGNORE INTO payment_recovery VALUES (1,NULL,NULL)").run();
  let recovering=false, nextRecovery=0;
  async function reconcilePayments() {
    if (recovering) return {state:"busy"};
    recovering=true;
    const report={state:"checked",discovered:0,refreshed:0,rejected:0,unavailable:0};
    const start=Date.now();
    try {
      const saved=db.prepare("SELECT * FROM payment_recovery WHERE id=1").get();
      const ids=new Set();
      if (typeof client.payments.list === "function") {
        try {
          const page=await client.payments.list({account_id:config.WHOP_COMPANY_ID,mode:"account_sales",order:"created_at",direction:"desc",first:5,...(saved.cursor ? {after:saved.cursor}:{})});
          if (!Array.isArray(page.data)) throw new Error("Invalid discovery response");
          for (const payment of page.data) if (getOrder(payment.metadata?.order_id || "")) {ids.add(payment.id);report.discovered++;}
          const info=page.response?.page_info || page.page_info;
          db.prepare("UPDATE payment_recovery SET cursor=? WHERE id=1").run(info?.has_next_page && info.end_cursor || null);
        } catch {report.unavailable++;}
      } else report.unavailable++;
      const known=db.prepare("SELECT payment_id FROM payment_receipts WHERE payment_id>? ORDER BY payment_id LIMIT 5").all(saved.payment_cursor || "");
      for (const row of known) ids.add(row.payment_id);
      let lastKnown=null;
      for (const id of ids) {
        if (Date.now()-start>25000) break;
        try {await reconcile(id);report.refreshed++;}
        catch(e) {if (e.status>=400 && e.status<500) report.rejected++;else report.unavailable++;}
        if (known.some(row=>row.payment_id===id)) lastKnown=id;
      }
      db.prepare("UPDATE payment_recovery SET payment_cursor=? WHERE id=1").run(lastKnown || null);
      return report;
    } finally {recovering=false;}
  }
  const timer = setInterval(() => {
    void drain();
    if (adapters.autoReconcile === true && Date.now()>=nextRecovery) {nextRecovery=Date.now()+30000;void reconcilePayments().catch(()=>{});}
    if (adapters.autoProvision === true) void drainProjects();
  }, 1000);
  timer.unref();
  return {
    server,
    db,
    checkout,
    reconcile,
    reconcilePayments,
    drain,
    drainProjects,
    controller,
    v2,
    paymentSnapshot: controller.paymentSnapshot,
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const service = createService(config);
  service.server.listen(Number(config.PAYMENTS_PORT || 3210), "127.0.0.1", () =>
    console.log(
      "Sandbox payment service listening on 127.0.0.1:" +
        (config.PAYMENTS_PORT || 3210),
    ),
  );
}
