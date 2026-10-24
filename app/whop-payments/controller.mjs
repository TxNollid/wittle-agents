import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
export const problem = (status, message) =>
  Object.assign(new Error(message), { status });
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const canonical = (value) => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize(value[k])]),
    );
  return value;
}
const need = (condition, status, message) => {
  if (!condition) throw problem(status, message);
};
const text = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
const key = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
export function createController(
  db,
  config,
  { now = () => Date.now(), rooms } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, role TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, snapshot TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, expires_at INTEGER NOT NULL, request_id TEXT NOT NULL, UNIQUE(seller_id,request_id));
    CREATE TABLE IF NOT EXISTS approvals (quote_id TEXT NOT NULL, principal_id TEXT NOT NULL, quote_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(quote_id,principal_id));
    CREATE TABLE IF NOT EXISTS project_jobs (order_id TEXT PRIMARY KEY, status TEXT NOT NULL, project_id TEXT, room_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, inputs_ready INTEGER NOT NULL DEFAULT 0, capacity_ready INTEGER NOT NULL DEFAULT 0, access_ready INTEGER NOT NULL DEFAULT 0, budget_minor INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS execution_budget (id INTEGER PRIMARY KEY CHECK(id=1), allowance_minor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, request_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, lease_until INTEGER NOT NULL, budget_minor INTEGER NOT NULL, spent_minor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cost_reservations (run_id TEXT NOT NULL, request_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, PRIMARY KEY(run_id,request_id));
    CREATE TABLE IF NOT EXISTS workflow_audit (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(orders)")
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of Object.entries({
    quote_id: "TEXT",
    quote_hash: "TEXT",
    quote_snapshot: "TEXT",
    workflow_status: "TEXT NOT NULL DEFAULT 'legacy_unbound'",
    payment_status: "TEXT NOT NULL DEFAULT 'pending'",
  }))
    if (!columns.has(name))
      db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS payment_acceptances (order_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, quote_hash TEXT NOT NULL, buyer_id TEXT NOT NULL, room_id TEXT NOT NULL, payment_id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, accepted_at TEXT NOT NULL, environment TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_receipts (payment_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, environment TEXT NOT NULL, customer_classification TEXT NOT NULL, provider_verified INTEGER NOT NULL, gross_minor INTEGER NOT NULL, refunded_minor INTEGER NOT NULL, currency TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_activity (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, mode TEXT NOT NULL, occurred_at TEXT NOT NULL, evidence_level TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_source (id INTEGER PRIMARY KEY CHECK(id=1), last_success_at TEXT);
    CREATE TABLE IF NOT EXISTS v2_quote_requests (buyer_id TEXT NOT NULL, room_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, quote_id TEXT NOT NULL, PRIMARY KEY(buyer_id,room_id,request_id));
  `);
  const receiptColumns = new Set(db.prepare("PRAGMA table_info(payment_receipts)").all().map(c=>c.name));
  for (const name of ["refund_status","dispute_status"]) if (!receiptColumns.has(name)) db.exec(`ALTER TABLE payment_receipts ADD COLUMN ${name} TEXT NOT NULL DEFAULT 'none'`);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS one_order_per_quote ON orders(quote_id) WHERE quote_id IS NOT NULL",
  );
  if (
    !db
      .prepare("PRAGMA table_info(cost_reservations)")
      .all()
      .some((c) => c.name === "action")
  )
    db.exec(
      "ALTER TABLE cost_reservations ADD COLUMN action TEXT NOT NULL DEFAULT ''",
    );
  db.prepare("INSERT OR IGNORE INTO execution_budget VALUES (1,?)").run(
    Number(config.EXECUTION_BUDGET_MINOR || 2000),
  );
  const audit = (actor, action, id) =>
    db
      .prepare(
        "INSERT INTO workflow_audit (actor_id,action,subject_id,created_at) VALUES (?,?,?,?)",
      )
      .run(actor.id, action, id, now());
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function principal(id) {
    return db
      .prepare("SELECT id,role,kind,revoked FROM principals WHERE id=?")
      .get(id);
  }
  function active(actor, role) {
    const p = principal(actor?.id);
    need(
      p && !p.revoked && (!role || p.role === role),
      403,
      "Principal is not authorized",
    );
    return p;
  }
  function operator(actor) {
    need(actor?.role === "operator", 403, "Operator access required");
  }
  function register(actor, input) {
    operator(actor);
    need(
      text(input.id) &&
        input.id.length <= 200 &&
        ["buyer", "seller"].includes(input.role) &&
        ["human", "agent"].includes(input.kind),
      400,
      "Principal ID, role and kind required",
    );
    need(!principal(input.id), 409, "Principal already exists");
    const token = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO principals (id,role,kind,token_hash) VALUES (?,?,?,?)",
    ).run(input.id, input.role, input.kind, hash(token));
    audit(actor, "register_principal", input.id);
    return { id: input.id, role: input.role, kind: input.kind, token };
  }
  const runToken = (run) =>
    "run." +
    run.id +
    "." +
    createHmac("sha256", config.PAYMENTS_SERVICE_TOKEN)
      .update(run.id + ":" + run.lease_until)
      .digest("hex");
  function authenticate(token) {
    if (token.startsWith("run.")) {
      const run = db
        .prepare("SELECT * FROM runs WHERE id=?")
        .get(token.split(".")[1] || "");
      if (!run || run.status !== "running" || run.lease_until <= now())
        return null;
      const a = Buffer.from(token),
        b = Buffer.from(runToken(run));
      return a.length === b.length && timingSafeEqual(a, b)
        ? { id: run.id, role: "worker", run_id: run.id }
        : null;
    }
    return db
      .prepare(
        "SELECT id,role,kind,revoked FROM principals WHERE token_hash=? AND revoked=0",
      )
      .get(hash(token));
  }
  function setService(actor, input) {
    operator(actor);
    need(
      text(input.id) && principal(input.seller_id)?.role === "seller",
      400,
      "Valid seller and service ID required",
    );
    need(
      Number.isSafeInteger(input.amount_minor) &&
        input.amount_minor > 0 &&
        input.currency === "usd" &&
        /^plan_/.test(input.plan_id || "") &&
        /^prod_/.test(input.product_id || "") &&
        input.account_id === config.WHOP_COMPANY_ID &&
        text(input.service_version),
      400,
      "Invalid sandbox service pricing/version",
    );
    need(
      Number.isSafeInteger(input.execution_cap_minor) &&
        input.execution_cap_minor > 0,
      400,
      "Execution cap required",
    );
    need(
      input.allowed_actions === undefined ||
        (Array.isArray(input.allowed_actions) &&
          input.allowed_actions.every(text)),
      400,
      "Allowed actions must be a list",
    );
    need(
      !db.prepare("SELECT id FROM services WHERE id=?").get(input.id),
      409,
      "Service versions are immutable; register a new ID",
    );
    need(input.prompt_version === undefined || (typeof input.prompt_version === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(input.prompt_version)),400,"Invalid immutable prompt version");
    const snapshot = {
      id: input.id,
      seller_id: input.seller_id,
      service_version: input.service_version,
      account_id: input.account_id,
      product_id: input.product_id,
      plan_id: input.plan_id,
      amount_minor: input.amount_minor,
      currency: "usd",
      execution_cap_minor: input.execution_cap_minor,
      allowed_actions: input.allowed_actions || [],
      environment: "sandbox",
      ...(input.prompt_version ? { prompt_version: input.prompt_version } : {}),
    };
    db.prepare("INSERT INTO services VALUES (?,?,?)").run(
      input.id,
      input.seller_id,
      canonical(snapshot),
    );
    audit(actor, "register_service", input.id);
    return snapshot;
  }
  function quoteRow(id) {
    const q = db.prepare("SELECT * FROM quotes WHERE id=?").get(id);
    need(q, 404, "Quote not found");
    return q;
  }
  function valid(q) {
    need(
      q.state === "active" && q.expires_at > now(),
      409,
      "Quote is expired, cancelled or superseded",
    );
  }
  function viewQuote(actor, id) {
    const q = quoteRow(id);
    need(
      actor?.role === "operator" ||
        (active(actor) && [q.buyer_id, q.seller_id].includes(actor.id)),
      403,
      "Quote access denied",
    );
    return {
      ...q,
      snapshot: JSON.parse(q.snapshot),
      approvals: db
        .prepare(
          "SELECT principal_id,quote_hash,created_at FROM approvals WHERE quote_id=?",
        )
        .all(id),
    };
  }
  function propose(actor, input) {
    active(actor, "seller");
    need(key(input.request_id), 400, "Retry key required");
    const serviceRow = db
      .prepare("SELECT snapshot FROM services WHERE id=?")
      .get(input.service_id);
    need(serviceRow, 404, "Service not found");
    const service = JSON.parse(serviceRow.snapshot);
    need(
      service.seller_id === actor.id,
      403,
      "Seller does not own this service",
    );
    need(
      principal(input.buyer_id)?.role === "buyer" &&
        !principal(input.buyer_id).revoked,
      400,
      "Registered buyer required",
    );
    const scope = input.scope;
    need(
      scope &&
        text(scope.title) &&
        Array.isArray(scope.deliverables) &&
        scope.deliverables.length > 0 &&
        scope.deliverables.every(text) &&
        Array.isArray(scope.acceptance_checks) &&
        scope.acceptance_checks.length > 0 &&
        scope.acceptance_checks.every(text) &&
        text(scope.refund_terms) &&
        text(scope.delivery_timing),
      400,
      "Scope, deliverables, acceptance checks, timing and refund terms required",
    );
    need(
      Number.isInteger(scope.revisions) &&
        scope.revisions >= 0 &&
        scope.revisions <= 10,
      400,
      "Revision allowance required",
    );
    for (const field of [
      "exclusions",
      "required_inputs",
      "permitted_recipients",
      "allowed_actions",
    ])
      need(
        Array.isArray(scope[field]) && scope[field].every(text),
        400,
        field + " must be a list",
      );
    need(
      scope.allowed_actions.every((action) =>
        (service.allowed_actions || []).includes(action),
      ),
      403,
      "Quote exceeds the operator service policy",
    );
    const expiry = Date.parse(input.expires_at);
    need(
      Number.isFinite(expiry) &&
        expiry > now() &&
        expiry <= now() + 30 * 86400000,
      400,
      "Quote expiry must be within 30 days",
    );
    const prior = input.supersedes ? quoteRow(input.supersedes) : null;
    const snapshot = {
      ...service,
      buyer_id: input.buyer_id,
      scope,
      expires_at: new Date(expiry).toISOString(),
      version: prior ? prior.version + 1 : 1,
      supersedes: prior?.id || null,
    };
    const digest = hash(canonical(snapshot));
    return transaction(() => {
      const retry = db
        .prepare("SELECT * FROM quotes WHERE seller_id=? AND request_id=?")
        .get(actor.id, input.request_id);
      if (retry) {
        need(
          retry.hash === digest,
          409,
          "Retry key used for a different quote",
        );
        return viewQuote(actor, retry.id);
      }
      const same = db.prepare("SELECT id FROM quotes WHERE hash=?").get(digest);
      if (same) return viewQuote(actor, same.id);
      if (prior) {
        need(
          prior.buyer_id === input.buyer_id && prior.seller_id === actor.id,
          403,
          "Cannot revise another agreement",
        );
        valid(prior);
        need(
          !db
            .prepare(
              "SELECT id FROM orders WHERE quote_id=? AND payment_id IS NOT NULL",
            )
            .get(prior.id),
          409,
          "Paid agreement cannot be changed",
        );
        db.prepare("UPDATE quotes SET state='superseded' WHERE id=?").run(
          prior.id,
        );
      }
      const id = randomUUID();
      db.prepare("INSERT INTO quotes VALUES (?,?,?,?,?,'active',?,?,?)").run(
        id,
        digest,
        input.buyer_id,
        actor.id,
        canonical(snapshot),
        snapshot.version,
        expiry,
        input.request_id,
      );
      db.prepare("INSERT INTO approvals VALUES (?,?,?,?)").run(
        id,
        actor.id,
        digest,
        now(),
      );
      audit(actor, "propose_quote", id);
      return viewQuote(actor, id);
    });
  }
  function approve(actor, id, input) {
    active(actor);
    const q = quoteRow(id);
    valid(q);
    need(!JSON.parse(q.snapshot).offer, 409, "V2 acceptance requires verified payment");
    need(
      [q.buyer_id, q.seller_id].includes(actor.id),
      403,
      "Not a party to this quote",
    );
    need(
      actor.role !== "buyer" || actor.kind === "human",
      403,
      "Human buyer approval required; no agent purchasing mandate is implemented",
    );
    need(
      input.quote_hash === q.hash && input.expected_version === q.version,
      409,
      "Approve the exact current quote hash/version",
    );
    db.prepare("INSERT OR IGNORE INTO approvals VALUES (?,?,?,?)").run(
      id,
      actor.id,
      q.hash,
      now(),
    );
    audit(actor, "approve_quote", id);
    return viewQuote(actor, id);
  }
  function approved(q) {
    const parties = [q.buyer_id, q.seller_id];
    need(
      parties.every((id) => principal(id) && !principal(id).revoked),
      409,
      "A quote party was revoked",
    );
    if (JSON.parse(q.snapshot).offer) {
      need(db.prepare("SELECT 1 FROM payment_acceptances WHERE quote_id=? AND quote_hash=?").get(q.id, q.hash), 409, "V2 verified payment acceptance required");
      return;
    }
    need(
      parties.every((id) =>
        db
          .prepare(
            "SELECT 1 FROM approvals WHERE quote_id=? AND principal_id=? AND quote_hash=?",
          )
          .get(q.id, id, q.hash),
      ),
      409,
      "Both parties must approve the exact quote",
    );
  }
  function checkoutBinding(actor, input) {
    active(actor, "buyer");
    need(actor.kind === "human", 403, "Human checkout required");
    need(text(input.quote_id), 409, "Accepted quote required");
    const q = quoteRow(input.quote_id);
    need(q.buyer_id === actor.id, 403, "Buyer does not own this quote");
    need(input.quote_hash === q.hash, 409, "Quote hash mismatch");
    valid(q);
    need(!JSON.parse(q.snapshot).offer, 409, "V2 checkout requires the room-bound adapter");
    approved(q);
    return { row: q, snapshot: JSON.parse(q.snapshot) };
  }
  function cancel(actor, id, input) {
    active(actor);
    const q = quoteRow(id);
    need(
      [q.buyer_id, q.seller_id].includes(actor.id),
      403,
      "Not a quote party",
    );
    need(
      q.hash === input.quote_hash && q.version === input.expected_version,
      409,
      "Quote version mismatch",
    );
    transaction(() => {
      db.prepare("UPDATE quotes SET state='cancelled' WHERE id=?").run(id);
      const orders = db
        .prepare("SELECT id FROM orders WHERE quote_id=?")
        .all(id);
      for (const o of orders) hold(o.id, "cancelled");
      audit(actor, "cancel_quote", id);
    });
    return viewQuote(actor, id);
  }
  function hold(orderId, state) {
    db.prepare("UPDATE orders SET workflow_status=? WHERE id=?").run(
      state,
      orderId,
    );
    db.prepare(
      "UPDATE project_jobs SET status='held',lease_id=NULL,lease_until=0,version=version+1 WHERE order_id=?",
    ).run(orderId);
    db.prepare(
      "UPDATE runs SET status='revoked' WHERE order_id=? AND status='running'",
    ).run(orderId);
  }
  // Called inside the same transaction that records the verified payment.
  function paymentRecorded(order) {
    db.prepare(
      "UPDATE orders SET payment_status='paid' WHERE id=? AND payment_status IN ('pending','failed')",
    ).run(order.id);
    if (!order.quote_id) {
      hold(order.id, "needs_attention");
      return;
    }
    if (order.workflow_status !== "awaiting_payment") {
      if (
        ["cancelled", "legacy_unbound", "needs_attention"].includes(
          order.workflow_status,
        )
      )
        hold(order.id, "needs_attention");
      return;
    }
    const q = quoteRow(order.quote_id);
    try {
      valid(q);
      if (JSON.parse(q.snapshot).offer) {
        need([q.buyer_id,q.seller_id].every(id => principal(id) && !principal(id).revoked),409,"Quote party revoked");
      } else approved(q);
    } catch {
      hold(order.id, "needs_attention");
      return;
    }
    need(q.hash === order.quote_hash, 422, "Order quote binding mismatch");
    const offer = JSON.parse(q.snapshot).offer;
    if (offer) db.prepare("INSERT OR IGNORE INTO payment_acceptances VALUES (?,?,?,?,?,?,?,?,?)").run(order.id,q.id,q.hash,q.buyer_id,offer.room_id,order.payment_id,"verified_payment",new Date(now()).toISOString(),offer.environment);
    db.prepare(
      "UPDATE orders SET workflow_status='paid_setup_pending',payment_status='paid' WHERE id=?",
    ).run(order.id);
    db.prepare(
      "INSERT OR IGNORE INTO project_jobs (order_id,status) VALUES (?,'pending')",
    ).run(order.id);
  }
  function adversePayment(orderId, state, receipt) {
    transaction(() => {
      if (receipt) {
        recordReceipt(receipt);
        db.prepare("UPDATE orders SET status='paid',payment_id=coalesce(payment_id,?) WHERE id=?").run(receipt.payment_id,orderId);
      }
      db.prepare("UPDATE orders SET payment_status=? WHERE id=?").run(
        state,
        orderId,
      );
      hold(orderId, state === "disputed" ? "disputed" : "needs_attention");
    });
  }
  function viewOrder(actor, id) {
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
    need(order, 404, "Order not found");
    const q = order.quote_id ? quoteRow(order.quote_id) : null;
    need(
      actor?.role === "operator" ||
        (active(actor) && q && [q.buyer_id, q.seller_id].includes(actor.id)),
      403,
      "Order access denied",
    );
    return {
      ...order,
      quote_snapshot: order.quote_snapshot
        ? JSON.parse(order.quote_snapshot)
        : null,
      project:
        db.prepare("SELECT * FROM project_jobs WHERE order_id=?").get(id) ||
        null,
    };
  }
  async function provision(actor, orderId) {
    operator(actor);
    const order = viewOrder(actor, orderId);
    const job = order.project;
    need(
      job &&
        order.payment_status === "paid" &&
        order.workflow_status === "paid_setup_pending",
      409,
      "Order is not awaiting paid setup",
    );
    need(
      rooms && typeof rooms.ensureProject === "function",
      503,
      "Rooms adapter is not connected; paid setup remains pending",
    );
    const leaseId = randomUUID();
    const claimed = db
      .prepare(
        "UPDATE project_jobs SET status='provisioning',lease_id=?,lease_until=?,attempts=attempts+1 WHERE order_id=? AND status IN ('pending','provisioning') AND lease_until<=? AND retry_at<=?",
      )
      .run(leaseId, now() + 60000, orderId, now(), now());
    need(
      claimed.changes === 1,
      409,
      "Project setup is leased or waiting to retry",
    );
    try {
      const q = order.quote_snapshot;
      // Adapter must reconcile this stable key before creating remotely after a timeout/restart.
      const result = await rooms.ensureProject({
        idempotency_key: "project:" + orderId,
        order_id: orderId,
        quote_hash: order.quote_hash,
        quote: q,
        participants: [q.buyer_id, q.seller_id],
      });
      need(
        text(result?.project_id) &&
          text(result?.room_id) &&
          result.buyer_access === true &&
          result.seller_access === true,
        503,
        "Project or participant access not ready",
      );
      if (q.offer) need(result.room_id === q.offer.room_id, 403, "Paid work must remain in the original buyer room");
      transaction(() => {
        const current = viewOrder(actor, orderId);
        need(
          current.workflow_status === "paid_setup_pending" &&
            current.payment_status === "paid",
          409,
          "Payment or agreement was revoked during setup",
        );
        const updated = db
          .prepare(
            "UPDATE project_jobs SET status='provisioned',project_id=?,room_id=?,access_ready=1,lease_id=NULL,lease_until=0,last_error=NULL,version=version+1 WHERE order_id=? AND lease_id=?",
          )
          .run(result.project_id, result.room_id, orderId, leaseId);
        need(updated.changes === 1, 409, "Provisioning lease lost");
        db.prepare(
          "UPDATE orders SET workflow_status='waiting_for_inputs' WHERE id=?",
        ).run(orderId);
        audit(actor, "provision_project", orderId);
      });
      return viewOrder(actor, orderId);
    } catch (e) {
      db.prepare(
        "UPDATE project_jobs SET status='pending',last_error=?,retry_at=?,lease_id=NULL,lease_until=0 WHERE order_id=? AND lease_id=?",
      ).run(
        e.status === 409 ? "state_changed" : "rooms_setup_failed",
        now() + 1000,
        orderId,
        leaseId,
      );
      throw e;
    }
  }
  function readiness(actor, id, input) {
    operator(actor);
    const order = viewOrder(actor, id);
    need(
      order.project?.status === "provisioned" &&
        order.payment_status === "paid",
      409,
      "Verified payment and project required",
    );
    need(
      order.workflow_status !== "running" &&
        order.workflow_status !== "needs_attention" &&
        order.workflow_status !== "disputed",
      409,
      "Order is not configurable",
    );
    need(
      input.expected_version === order.project.version,
      409,
      "Project version mismatch",
    );
    const cap = order.quote_snapshot.execution_cap_minor;
    need(
      typeof input.inputs_ready === "boolean" &&
        typeof input.capacity_ready === "boolean" &&
        Number.isSafeInteger(input.budget_minor) &&
        input.budget_minor > 0 &&
        input.budget_minor <= cap,
      400,
      "Readiness and a budget within the service cap are required",
    );
    const state = !input.inputs_ready
      ? "waiting_for_inputs"
      : !input.capacity_ready
        ? "waiting_for_capacity"
        : "ready";
    transaction(() => {
      db.prepare(
        "UPDATE project_jobs SET inputs_ready=?,capacity_ready=?,budget_minor=?,version=version+1 WHERE order_id=?",
      ).run(
        Number(input.inputs_ready),
        Number(input.capacity_ready),
        input.budget_minor,
        id,
      );
      db.prepare("UPDATE orders SET workflow_status=? WHERE id=?").run(
        state,
        id,
      );
      audit(actor, "update_readiness", id);
    });
    return viewOrder(actor, id);
  }
  function claimRun(actor, id, input) {
    operator(actor);
    need(key(input.request_id), 400, "Run retry key required");
    return transaction(() => {
      const existing = db
        .prepare("SELECT * FROM runs WHERE request_id=?")
        .get(input.request_id);
      if (existing) {
        need(
          existing.order_id === id &&
            existing.status === "running" &&
            existing.lease_until > now(),
          409,
          "Run key belongs to another or inactive run",
        );
        return { ...existing, token: runToken(existing) };
      }
      const o = viewOrder(actor, id),
        j = o.project;
      need(
        o.payment_status === "paid" &&
          o.workflow_status === "ready" &&
          j?.access_ready &&
          j.inputs_ready &&
          j.capacity_ready,
        409,
        "Project is not ready for execution",
      );
      const q = quoteRow(o.quote_id);
      need(q.state === "active", 409, "Agreement cancelled");
      approved(q);
      need(
        !db.prepare("SELECT id FROM runs WHERE status='running'").get(),
        409,
        "A worker is already running; recovery of expired runs requires reconciliation",
      );
      const allowance = db
        .prepare("SELECT allowance_minor FROM execution_budget WHERE id=1")
        .get().allowance_minor;
      const reserved = db
        .prepare("SELECT coalesce(sum(budget_minor),0) AS n FROM runs")
        .get().n;
      need(
        reserved + j.budget_minor <= allowance,
        409,
        "Owner execution budget exhausted",
      );
      const run = {
        id: randomUUID(),
        order_id: id,
        request_id: input.request_id,
        status: "running",
        lease_until: now() + 15 * 60000,
        budget_minor: j.budget_minor,
        spent_minor: 0,
      };
      db.prepare("INSERT INTO runs (id,order_id,request_id,status,lease_until,budget_minor,spent_minor) VALUES (?,?,?,?,?,?,?)").run(
        run.id,
        id,
        input.request_id,
        run.status,
        run.lease_until,
        run.budget_minor,
        0,
      );
      db.prepare("UPDATE orders SET workflow_status='running' WHERE id=?").run(
        id,
      );
      audit(actor, "claim_run", id);
      return { ...run, token: runToken(run) };
    });
  }
  function reserveCost(actor, runId, input) {
    need(
      actor?.role === "operator" ||
        (actor?.role === "worker" && actor.run_id === runId),
      403,
      "Run-scoped worker or operator access required",
    );
    need(
      key(input.request_id) &&
        Number.isSafeInteger(input.amount_minor) &&
        input.amount_minor > 0,
      400,
      "Bounded positive cost and retry key required",
    );
    return transaction(() => {
      const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
      need(
        run && run.status === "running" && run.lease_until > now(),
        409,
        "Run lease inactive",
      );
      const o = viewOrder({ role: "operator" }, run.order_id);
      need(
        o.payment_status === "paid" && o.workflow_status === "running",
        409,
        "Run revoked",
      );
      approved(quoteRow(o.quote_id));
      need(
        o.quote_snapshot.scope.allowed_actions.includes(input.action),
        403,
        "Action is outside the accepted scope",
      );
      const prior = db
        .prepare(
          "SELECT * FROM cost_reservations WHERE run_id=? AND request_id=?",
        )
        .get(runId, input.request_id);
      if (prior) {
        need(
          prior.amount_minor === input.amount_minor &&
            prior.action === input.action,
          409,
          "Retry amount/action mismatch",
        );
        return prior;
      }
      need(
        run.spent_minor + input.amount_minor <= run.budget_minor,
        409,
        "Run budget exhausted",
      );
      db.prepare(
        "INSERT INTO cost_reservations (run_id,request_id,amount_minor,action) VALUES (?,?,?,?)",
      ).run(runId, input.request_id, input.amount_minor, input.action);
      db.prepare("UPDATE runs SET spent_minor=spent_minor+? WHERE id=?").run(
        input.amount_minor,
        runId,
      );
      return { run_id: runId, ...input };
    });
  }
  function revoke(actor, id) {
    operator(actor);
    need(principal(id), 404, "Principal not found");
    transaction(() => {
      db.prepare("UPDATE principals SET revoked=1 WHERE id=?").run(id);
      for (const q of db
        .prepare("SELECT id FROM quotes WHERE buyer_id=? OR seller_id=?")
        .all(id, id))
        for (const o of db
          .prepare("SELECT id FROM orders WHERE quote_id=?")
          .all(q.id))
          hold(o.id, "needs_attention");
      audit(actor, "revoke_principal", id);
    });
    return { revoked: true };
  }
  // Server-only financial source. Caller has retrieved and validated the full provider tuple.
  function recordReceipt(row) {
    // Provider snapshots can arrive out of order. Collected value and observed
    // adverse evidence persist until an explicit supported resolution, never a
    // generic pending/failed/success replay.
    db.prepare(`INSERT INTO payment_receipts
      (payment_id,order_id,environment,customer_classification,provider_verified,gross_minor,refunded_minor,currency,state,at,refund_status,dispute_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(payment_id) DO UPDATE SET
        state=CASE
          WHEN payment_receipts.state='disputed' THEN 'disputed'
          WHEN payment_receipts.state='refunded' AND excluded.state!='disputed' THEN 'refunded'
          WHEN payment_receipts.state='paid' AND excluded.state IN ('pending','failed') THEN 'paid'
          ELSE excluded.state END,
        refunded_minor=max(payment_receipts.refunded_minor,excluded.refunded_minor),
        at=CASE WHEN payment_receipts.state='paid' AND excluded.state IN ('pending','failed') THEN payment_receipts.at ELSE excluded.at END,
        refund_status=CASE
          WHEN payment_receipts.refund_status='full' OR excluded.refund_status='full' THEN 'full'
          WHEN payment_receipts.refund_status='partial' OR excluded.refund_status='partial' THEN 'partial'
          WHEN payment_receipts.refund_status='pending' OR excluded.refund_status='pending' THEN 'pending'
          ELSE 'none' END,
        dispute_status=CASE WHEN excluded.dispute_status='none' AND payment_receipts.dispute_status!='none'
          THEN payment_receipts.dispute_status ELSE excluded.dispute_status END
    `).run(row.payment_id,row.order_id,row.environment,row.customer_classification,1,row.gross_minor,row.refunded_minor,"USD",row.state,row.at,row.refund_status || "none",row.dispute_status || "none");
    db.prepare("INSERT INTO payment_source VALUES (1,?) ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at").run(new Date(now()).toISOString());
  }
  function paymentSnapshot() {
    return {mode:config.PAYMENT_EVIDENCE_LEVEL === "fixture" ? "fixture" : "sandbox", evidence_level:config.PAYMENT_EVIDENCE_LEVEL || "local_execution",last_success_at:db.prepare("SELECT last_success_at FROM payment_source WHERE id=1").get()?.last_success_at || null,ledger_complete:false,ledger:db.prepare("SELECT * FROM payment_receipts").all().map(r=>({...r,provider_verified:r.provider_verified===1})),activity:db.prepare("SELECT * FROM payment_activity ORDER BY occurred_at DESC LIMIT 2000").all()};
  }
  return {
    recordReceipt,
    paymentSnapshot,
    register,
    authenticate,
    setService,
    propose,
    approve,
    viewQuote,
    checkoutBinding,
    cancel,
    paymentRecorded,
    adversePayment,
    viewOrder,
    provision,
    readiness,
    claimRun,
    reserveCost,
    revoke,
    principal,
    transaction,
  };
}
