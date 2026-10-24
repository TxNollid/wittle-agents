import { createHash } from "node:crypto";

const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
}
export const hashOffer = (offer) => createHash("sha256").update(canonical(offer)).digest("hex");
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const stops = new Set(["refund", "dispute", "quote_cancelled", "access_revoked", "operator_stop"]);

// Trusted supervisor API only. Never expose controller/operator or these ports to a model.
export function createFulfillment({ db, controller, operator, paymentAcceptance, membership, runtime,
  mode, now = () => Date.now(), retryDelayMs = 1000, maxStarts = 3, timeoutMs = 10000 }) {
  need(db?.prepare && db?.exec && operator?.role === "operator", "TRUSTED_CONTROLLER_REQUIRED");
  for (const name of ["viewOrder", "viewQuote", "provision", "readiness", "claimRun", "reserveCost", "principal"])
    need(typeof controller?.[name] === "function", "CONTROLLER_PORT_REQUIRED");
  need(typeof paymentAcceptance === "function" && typeof membership === "function", "AUTHORITY_PORT_REQUIRED");
  for (const name of ["check", "start", "status", "cancel"])
    need(typeof runtime?.[name] === "function", "RUNTIME_PORT_REQUIRED");
  need(["fixture", "sandbox", "live"].includes(mode) && positive(retryDelayMs) &&
    positive(maxStarts) && maxStarts <= 10 && positive(timeoutMs) && timeoutMs <= 60000, "INVALID_CONFIGURATION");
  db.exec(`CREATE TABLE IF NOT EXISTS fulfillment_dispatch (
    order_id TEXT PRIMARY KEY, binding TEXT NOT NULL, claim_key TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL, job TEXT, starts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, reason TEXT, updated_at INTEGER NOT NULL,
    stopped INTEGER NOT NULL DEFAULT 0
  )`);
  if (!db.prepare("PRAGMA table_info(fulfillment_dispatch)").all().some((column) => column.name === "stopped"))
    db.exec("ALTER TABLE fulfillment_dispatch ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE fulfillment_dispatch SET stopped=1 WHERE phase IN ('cancel_pending','cancelled') OR reason='cancellation_unconfirmed'");
  const row = (orderId) => db.prepare("SELECT * FROM fulfillment_dispatch WHERE order_id=?").get(orderId);
  const inFlight = new Map();
  async function bounded(fn, input) {
    const abort = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn({ ...input, signal: abort.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(Object.assign(new Error("PORT_TIMEOUT"), { code: "PORT_TIMEOUT" })); }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const remote = (name, input) => bounded((args) => runtime[name](args), input);
  const update = (orderId, phase, reason = null, retryAt = 0, expectedPhase = null) =>
    db.prepare(`UPDATE fulfillment_dispatch SET phase=?,reason=?,retry_at=?,updated_at=?
      WHERE order_id=? AND phase!='cancelled'
        AND (stopped=0 OR ? IN ('cancel_pending','cancelled','needs_attention'))
        AND (? IS NULL OR phase=?)`)
      .run(phase, reason, retryAt, now(), orderId, phase, expectedPhase, expectedPhase);
  const view = (saved) => {
    if (!saved) return null;
    const job = saved.job ? JSON.parse(saved.job) : null;
    return { order_id: saved.order_id, state: saved.phase === "pending" ? "paid_waiting" :
      ["claiming", "starting"].includes(saved.phase) ? "needs_attention" : saved.phase,
    reason: saved.reason || (["claiming", "starting"].includes(saved.phase) ? "unknown_start_outcome" : null),
    retry_at: saved.retry_at, starts: saved.starts, job,
    mode, updated_at: new Date(saved.updated_at).toISOString() };
  };

  async function load(orderId) {
    need(id(orderId), "INVALID_ORDER_ID");
    const order = controller.viewOrder(operator, orderId);
    const snapshot = order.quote_snapshot;
    const offer = snapshot?.offer;
    const accepted = await paymentAcceptance(orderId);
    need(offer?.schema_version === "wa-v2.1" && accepted?.source === "verified_payment", "V2_PAYMENT_REQUIRED");
    need(offer.provider === "whop" && ["sandbox", "live"].includes(offer.environment) &&
      (mode === "fixture" || offer.environment === mode), "ENVIRONMENT_MISMATCH");
    need(offer.currency === "USD" && positive(offer.amount_minor) && snapshot.currency === "usd" &&
      snapshot.amount_minor === offer.amount_minor && snapshot.account_id === offer.company_id &&
      snapshot.product_id === offer.product_id && snapshot.plan_id === offer.plan_id &&
      snapshot.seller_id === offer.seller_id && snapshot.service_version === offer.service_version &&
      snapshot.environment === offer.environment && positive(snapshot.execution_cap_minor) &&
      id(snapshot.prompt_version) && canonical(snapshot.scope) === canonical(offer.scope), "OFFER_SNAPSHOT_MISMATCH");
    need(id(offer.buyer_id) && id(offer.room_id) && id(offer.seller_id) &&
      id(order.payment_id) && order.buyer_id === offer.buyer_id && order.quote_hash === hashOffer(offer), "OFFER_BINDING_MISMATCH");
    const quote = controller.viewQuote(operator, order.quote_id);
    need(quote.hash === order.quote_hash && quote.buyer_id === offer.buyer_id &&
      quote.seller_id === offer.seller_id && canonical(quote.snapshot) === canonical(snapshot), "QUOTE_BINDING_MISMATCH");
    need(accepted.order_id === order.id && accepted.quote_id === order.quote_id &&
      accepted.quote_hash === order.quote_hash && accepted.buyer_id === offer.buyer_id &&
      accepted.room_id === offer.room_id && accepted.payment_id === order.payment_id &&
      accepted.environment === offer.environment, "PAYMENT_BINDING_MISMATCH");
    const acceptedAt = Date.parse(accepted.accepted_at), expiresAt = Date.parse(offer.expires_at);
    need(Number.isFinite(acceptedAt) && acceptedAt <= now() && Number.isFinite(expiresAt) &&
      acceptedAt < expiresAt, "LATE_PAYMENT");
    // Expiry gates acceptance, not a correctly accepted job waiting for runtime recovery.
    need(order.payment_status === "paid" && quote.state === "active" &&
      !["cancelled", "needs_attention", "disputed", "legacy_unbound"].includes(order.workflow_status), "PAYMENT_INELIGIBLE");
    need(controller.principal(offer.buyer_id)?.revoked === 0 &&
      controller.principal(offer.seller_id)?.revoked === 0, "PRINCIPAL_REVOKED");
    const binding = canonical({ order_id: order.id, quote_id: order.quote_id, quote_hash: order.quote_hash,
      payment_id: order.payment_id, offer, prompt_version: snapshot.prompt_version,
      execution_cap_minor: snapshot.execution_cap_minor });
    const saved = row(orderId);
    need(!saved || saved.binding === binding, "PERSISTED_BINDING_MISMATCH");
    return { order, snapshot, offer, binding };
  }

  function validateAccess(context, proof) {
    const { offer } = context;
    const verifiedAt = Date.parse(proof?.verified_at), expiresAt = Date.parse(proof?.expires_at);
    need(proof?.buyer_id === offer.buyer_id && proof?.room_id === offer.room_id && proof.mode === mode &&
      (mode === "fixture" ? proof.evidence_level === "fixture" : proof.evidence_level === "provider") &&
      id(proof.membership_id) && id(proof.source_event_id) && proof.revoked_at === null &&
      Number.isFinite(verifiedAt) && verifiedAt <= now() && now() - verifiedAt <= 60000 && Number.isFinite(expiresAt) &&
      expiresAt > now() && verifiedAt < expiresAt, "MEMBERSHIP_UNAVAILABLE");
  }
  async function access(context) {
    const proof = await bounded(membership, { buyer_id: context.offer.buyer_id, room_id: context.offer.room_id });
    validateAccess(context, proof);
    return proof;
  }
  function baseJob(context, attemptId) {
    return { schema_version: "wa-v2.1", order_id: context.order.id, job_id: context.order.id,
      attempt_id: attemptId, buyer_id: context.offer.buyer_id, room_id: context.offer.room_id,
      quote_id: context.order.quote_id, quote_hash: context.order.quote_hash,
      service_version: context.offer.service_version, prompt_version: context.snapshot.prompt_version,
      mode, scope: context.offer.scope, revision: 0 };
  }
  async function checkRuntime(context, requireSlot = true) {
    let check;
    try {
      check = await remote("check", { order_id: context.order.id, buyer_id: context.offer.buyer_id,
        room_id: context.offer.room_id, quote_hash: context.order.quote_hash, prompt_version: context.snapshot.prompt_version });
    } catch { throw Object.assign(new Error("RUNTIME_UNAVAILABLE"), { code: "RUNTIME_UNAVAILABLE" }); }
    validateRuntime(context, check, requireSlot);
    return check;
  }
  function validateRuntime(context, check, requireSlot = true) {
    const ready = check?.readiness;
    need(check?.buyer_id === context.offer.buyer_id && check?.room_id === context.offer.room_id,
      "RUNTIME_BINDING_MISMATCH");
    need(check.mode === mode && (mode === "fixture" ? check.evidence_level === "fixture" : check.evidence_level === "provider") &&
      ready && ready.stale === false && Date.parse(ready.observed_at) <= now() &&
      Date.parse(ready.expires_at) > now() && Date.parse(ready.observed_at) < Date.parse(ready.expires_at) &&
      ready.membership_ready === true && ready.host_lead_ready === true &&
      ready.credential_boundary_verified === true && Number.isSafeInteger(ready.available_slots) &&
      ready.available_slots >= 0 && (!requireSlot || ready.available_slots > 0), "RUNTIME_UNAVAILABLE");
    need(check.inputs_ready === true && positive(check.budget_minor) &&
      check.budget_minor <= context.snapshot.execution_cap_minor, "INPUTS_OR_BUDGET_UNAVAILABLE");
  }
  function validateCurrent(context) {
    const current = controller.viewOrder(operator, context.order.id);
    const quote = controller.viewQuote(operator, context.order.quote_id);
    need(current.quote_id === context.order.quote_id && current.quote_hash === context.order.quote_hash &&
      current.payment_id === context.order.payment_id && current.buyer_id === context.offer.buyer_id &&
      quote.hash === context.order.quote_hash && canonical(current.quote_snapshot) === canonical(context.snapshot) &&
      canonical(quote.snapshot) === canonical(context.snapshot), "PERSISTED_BINDING_MISMATCH");
    need(current.payment_status === "paid" && quote.state === "active" &&
      !["cancelled", "needs_attention", "disputed", "legacy_unbound"].includes(current.workflow_status), "PAYMENT_INELIGIBLE");
    need(controller.principal(context.offer.buyer_id)?.revoked === 0 &&
      controller.principal(context.offer.seller_id)?.revoked === 0, "PRINCIPAL_REVOKED");
  }
  function matches(receipt, job, key) {
    return receipt?.job_id === job.job_id && receipt.attempt_id === job.attempt_id &&
      receipt.room_id === job.room_id && receipt.buyer_id === job.buyer_id &&
      receipt.quote_hash === job.quote_hash && receipt.request_id === key;
  }
  function attention(orderId, reason) { update(orderId, "needs_attention", reason); return view(row(orderId)); }
  function retry(orderId, reason, expectedPhase = null) {
    if (row(orderId).stopped) return view(row(orderId));
    if (row(orderId).starts >= maxStarts) return attention(orderId, "retry_limit");
    update(orderId, "pending", reason, now() + retryDelayMs * 2 ** Math.max(0, row(orderId).starts - 1), expectedPhase);
    return view(row(orderId));
  }

  async function cancel(orderId, reason) {
    need(stops.has(reason), "INVALID_CANCEL_REASON");
    const saved = row(orderId);
    need(saved, "DISPATCH_NOT_FOUND");
    if (saved.phase === "cancelled") return view(saved);
    // The adapter's action gateway denies immediately, even if interruption is unconfirmed.
    db.prepare("UPDATE fulfillment_dispatch SET stopped=1 WHERE order_id=?").run(orderId);
    update(orderId, "cancel_pending", reason);
    if (!saved.job || saved.starts === 0) { update(orderId, "cancelled", reason); return view(row(orderId)); }
    const job = JSON.parse(saved.job);
    try {
      const receipt = await remote("cancel", { job, request_id: saved.claim_key, reason });
      if (!matches(receipt, job, saved.claim_key) || receipt.state !== "cancelled")
        return attention(orderId, "cancellation_unconfirmed");
      update(orderId, "cancelled", reason);
      return view(row(orderId));
    } catch { return attention(orderId, "cancellation_unconfirmed"); }
  }

  async function authorizeAction(orderId, attemptId, input) {
    const saved = row(orderId);
    need(saved && !saved.stopped && ["starting", "running"].includes(saved.phase), "ACTION_REVOKED");
    const job = JSON.parse(saved.job);
    need(job.attempt_id === attemptId, "ATTEMPT_MISMATCH");
    const context = await load(orderId);
    const proof = await access(context);
    const health = await checkRuntime(context, false);
    // Retain and revalidate both attestations after ALL awaits. No await may follow this barrier.
    await load(orderId);
    validateAccess(context, proof);
    validateRuntime(context, health, false);
    validateCurrent(context);
    need(!row(orderId).stopped && ["starting", "running"].includes(row(orderId).phase), "ACTION_REVOKED");
    return controller.reserveCost(operator, attemptId, input);
  }

  async function dispatchOnce(orderId) {
    let context;
    try { context = await load(orderId); await access(context); }
    catch (error) {
      const saved = row(orderId);
      if (saved?.job && saved.starts > 0) return cancel(orderId, "access_revoked");
      if (saved) return attention(orderId, error.code || "authority_unavailable");
      throw error;
    }
    db.prepare("INSERT OR IGNORE INTO fulfillment_dispatch(order_id,binding,claim_key,phase,updated_at) VALUES (?,?,?,'pending',?)")
      .run(orderId, context.binding, `fulfillment_${hashOffer(orderId)}`, now());
    let saved = row(orderId);
    need(saved.binding === context.binding, "PERSISTED_BINDING_MISMATCH");
    if (saved.phase !== "pending" || saved.retry_at > now()) return view(saved);
    const acquired = db.prepare("UPDATE fulfillment_dispatch SET phase='claiming',updated_at=? WHERE order_id=? AND phase='pending' AND stopped=0 AND retry_at<=?")
      .run(now(), orderId, now());
    if (!acquired.changes) return view(row(orderId));
    let run, health;
    try {
      health = await checkRuntime(context);
      context = await load(orderId);
      const proof = await access(context);
      await load(orderId);
      if (row(orderId).phase !== "claiming") return view(row(orderId));
      if (context.order.workflow_status === "paid_setup_pending") await controller.provision(operator, orderId);
      context = await load(orderId);
      if (row(orderId).phase !== "claiming") return view(row(orderId));
      validateAccess(context, proof);
      validateRuntime(context, health);
      validateCurrent(context);
      if (row(orderId).stopped) return view(row(orderId));
      need(context.order.project?.room_id === context.offer.room_id && context.order.project?.access_ready === 1,
        "ROOM_NOT_READY");
      if (!saved.job) {
        controller.readiness(operator, orderId, { expected_version: context.order.project.version,
          inputs_ready: true, capacity_ready: true, budget_minor: health.budget_minor });
      }
      // Existing controller is the only claim/lease/budget authority. Same key recovers a claim.
      run = controller.claimRun(operator, orderId, { request_id: saved.claim_key });
      const job = baseJob(context, run.id);
      need(!saved.job || canonical(JSON.parse(saved.job)) === canonical(job), "ATTEMPT_MISMATCH");
      db.prepare("UPDATE fulfillment_dispatch SET job=?,updated_at=? WHERE order_id=? AND phase='claiming'")
        .run(JSON.stringify(job), now(), orderId);
    } catch (error) {
      if (row(orderId).phase !== "claiming") return view(row(orderId));
      if (["RUNTIME_UNAVAILABLE", "INPUTS_OR_BUDGET_UNAVAILABLE", "ROOM_NOT_READY", "MEMBERSHIP_UNAVAILABLE"].includes(error.code) || error.status === 503)
        return retry(orderId, error.code || "runtime_unavailable");
      return attention(orderId, error.code || "controller_not_ready");
    }
    saved = row(orderId);
    const job = JSON.parse(saved.job);
    try {
      context = await load(orderId);
      const proof = await access(context);
      await load(orderId);
      validateAccess(context, proof);
      validateRuntime(context, health);
      validateCurrent(context);
    } catch (error) {
      if (error.code === "RUNTIME_UNAVAILABLE") return retry(orderId, error.code);
      return cancel(orderId, "access_revoked");
    }
    const claimed = db.prepare("UPDATE fulfillment_dispatch SET phase='starting',starts=starts+1,reason=NULL,updated_at=? WHERE order_id=? AND phase='claiming' AND stopped=0")
      .run(now(), orderId);
    if (!claimed.changes) return view(row(orderId));
    try {
      const receipt = await remote("start", { job, request_id: saved.claim_key,
        authorizeAction: (input) => authorizeAction(orderId, run.id, input) });
      if (row(orderId).phase !== "starting") return view(row(orderId));
      if (!matches(receipt, job, saved.claim_key)) return attention(orderId, "start_receipt_mismatch");
      try {
        context = await load(orderId);
        const proof = await access(context);
        await load(orderId);
        validateAccess(context, proof);
        validateRuntime(context, health, false);
        validateCurrent(context);
      }
      catch { return cancel(orderId, "access_revoked"); }
      if (row(orderId).phase !== "starting") return view(row(orderId));
      if (receipt.state === "not_sent") return retry(orderId, "definitely_not_sent");
      if (receipt.state === "needs_attention" && receipt.reason === "unknown_send_outcome")
        return attention(orderId, "unknown_send_outcome");
      if (!["running", "result_ready"].includes(receipt.state)) return attention(orderId, "unknown_start_outcome");
      update(orderId, receipt.state);
      return view(row(orderId));
    } catch {
      return row(orderId).phase === "starting" ? attention(orderId, "unknown_start_outcome") : view(row(orderId));
    }
  }
  function dispatch(orderId) {
    if (inFlight.has(orderId)) return inFlight.get(orderId);
    const work = dispatchOnce(orderId).finally(() => inFlight.delete(orderId));
    inFlight.set(orderId, work);
    return work;
  }

  // Operator-only reconciliation; a missing/not-found response is NOT proof of not-sent.
  async function reconcile(orderId) {
    need(!inFlight.has(orderId), "DISPATCH_IN_PROGRESS");
    const saved = row(orderId);
    need(saved && ["claiming", "starting", "needs_attention", "running", "cancel_pending"].includes(saved.phase), "NOT_RECONCILABLE");
    if (!saved.job) {
      // No remote call is possible before job/start intent persistence. Reconcile only the existing local claim.
      need(saved.starts === 0, "MISSING_ATTEMPT_BINDING");
      try {
        const context = await load(orderId);
        const proof = await access(context);
        await load(orderId);
        validateAccess(context, proof);
        validateCurrent(context);
        if (row(orderId).stopped || row(orderId).phase !== saved.phase) return view(row(orderId));
        const claimed = db.prepare("SELECT id FROM runs WHERE request_id=?").get(saved.claim_key);
        if (claimed) {
          const run = controller.claimRun(operator, orderId, { request_id: saved.claim_key });
          db.prepare("UPDATE fulfillment_dispatch SET job=? WHERE order_id=? AND stopped=0 AND phase=?")
            .run(JSON.stringify(baseJob(context, run.id)), orderId, saved.phase);
        }
        update(orderId, "pending", "local_claim_reconciled", 0, saved.phase);
        return view(row(orderId));
      } catch { return attention(orderId, "claim_reconciliation_required"); }
    }
    const job = JSON.parse(saved.job);
    let receipt;
    try { receipt = await remote("status", { job, request_id: saved.claim_key }); }
    catch { return attention(orderId, "status_unavailable"); }
    if (!matches(receipt, job, saved.claim_key)) return attention(orderId, "status_receipt_mismatch");
    if (receipt.state === "cancelled") {
      db.prepare("UPDATE fulfillment_dispatch SET stopped=1 WHERE order_id=?").run(orderId);
      update(orderId, "cancelled", "runtime_cancelled");
      return view(row(orderId));
    }
    if (row(orderId).stopped || row(orderId).phase !== saved.phase) return view(row(orderId));
    try {
      const context = await load(orderId);
      const proof = await access(context);
      await load(orderId);
      validateAccess(context, proof);
      validateCurrent(context);
    }
    catch { return cancel(orderId, "access_revoked"); }
    if (row(orderId).stopped || row(orderId).phase !== saved.phase) return view(row(orderId));
    if (receipt.state === "not_sent") return retry(orderId, "operator_confirmed_not_sent", saved.phase);
    if (!["running", "result_ready"].includes(receipt.state)) return attention(orderId, "unknown_start_outcome");
    update(orderId, receipt.state, null, 0, saved.phase);
    return view(row(orderId));
  }

  async function drain(limit = 10) {
    need(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "INVALID_DRAIN_LIMIT");
    const orders = db.prepare(`SELECT o.id FROM orders o JOIN project_jobs j ON j.order_id=o.id
      LEFT JOIN fulfillment_dispatch f ON f.order_id=o.id
      WHERE o.quote_id IS NOT NULL AND json_extract(o.quote_snapshot,'$.offer.schema_version')='wa-v2.1'
        AND ((o.payment_status='paid' AND (f.order_id IS NULL OR (f.phase='pending' AND f.retry_at<=?)))
          OR f.phase IN ('claiming','starting','running','result_ready','needs_attention','cancel_pending'))
      ORDER BY o.created_at,o.id LIMIT ?`).all(now(), limit);
    const results = [];
    for (const { id: orderId } of orders) {
      try { results.push(await dispatch(orderId)); }
      catch (error) { results.push({ order_id: orderId, state: "needs_attention", reason: error.code || "authority_unavailable", mode }); }
    }
    return results;
  }
  return { dispatch, drain, reconcile, cancel, authorizeAction, inspect: (orderId) => view(row(orderId)) };
}
