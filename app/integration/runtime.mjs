import { auditScope } from "../auditor/audit.mjs";
import { hashOffer as digest } from "../fulfillment/index.mjs";

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const need = (ok, code, status) => { if (!ok) throw fail(code, status); };
const validKey = (key) => typeof key === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(key);

// Website Auditor execution metadata, not a second payment, lease or cost ledger.
// The existing controller remains the only authority for those decisions.
export function createAuditRuntime({ db, mode, readHealth, execute, costs, now = Date.now }) {
  need(["fixture", "sandbox", "live"].includes(mode) && typeof readHealth === "function" && typeof execute === "function",
    "RUNTIME_PORT_UNAVAILABLE", 503);
  for (const action of ["browse_public_pages", "write_audit_report", "deliver_in_bound_room"])
    need(Number.isSafeInteger(costs?.[action]) && costs[action] > 0, "ACTION_COST_POLICY_REQUIRED", 503);
  db.exec(`CREATE TABLE IF NOT EXISTS integration_audit_runs (
    request_id TEXT PRIMARY KEY, job_hash TEXT NOT NULL, job TEXT NOT NULL,
    state TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0,
    result TEXT, reason TEXT, created_at INTEGER NOT NULL
  )`);
  db.prepare("UPDATE integration_audit_runs SET state='needs_attention',reason='RUNTIME_PROCESS_INTERRUPTED' WHERE state='running'").run();
  const active = new Map();
  const row = (key) => db.prepare("SELECT * FROM integration_audit_runs WHERE request_id=?").get(key);
  function bound({ job, request_id }) {
    need(validKey(request_id), "INVALID_RUNTIME_KEY", 400);
    auditScope(job);
    need(job.mode === mode, "RUNTIME_MODE_MISMATCH", 403);
    const saved = row(request_id);
    need(!saved || saved.job_hash === digest(job), "RUNTIME_BINDING_MISMATCH", 403);
    return saved;
  }
  const receipt = ({ job, request_id }, state, reason = null) => ({
    request_id, state, reason, job_id: job.job_id, attempt_id: job.attempt_id,
    buyer_id: job.buyer_id, room_id: job.room_id, quote_hash: job.quote_hash,
  });
  function assertActive(key) {
    need(row(key)?.state === "running" && !row(key).stopped && active.has(key), "RUNTIME_ACTION_REVOKED", 403);
    active.get(key).controller.signal.throwIfAborted();
  }
  async function guard(key, operation, detail = null) {
    assertActive(key);
    const running = active.get(key);
    const action = { audit: "browse_public_pages", observe: "browse_public_pages", persist_result: "write_audit_report",
      persist_revision: "write_audit_report", revise: "browse_public_pages", deliver: "deliver_in_bound_room" }[operation];
    need(action, "RUNTIME_OPERATION_FORBIDDEN", 403);
    const request = { request_id: `audit_${digest({ key, operation, detail })}`, action, amount_minor: costs[action] };
    const grant = await running.authorizeAction(request);
    assertActive(key); // cancel during the authority await is monotonic
    return grant;
  }
  function start(input) {
    const job = structuredClone(input.job), request_id = input.request_id;
    const saved = bound({ job, request_id });
    if (saved) return receipt({ job, request_id }, saved.state, saved.reason);
    need(typeof input.authorizeAction === "function", "CURRENT_ACTION_AUTHORITY_REQUIRED", 503);
    if (input.signal?.aborted) return receipt({ job, request_id }, "not_sent");
    db.prepare("INSERT INTO integration_audit_runs VALUES (?,?,?,'running',0,NULL,NULL,?)")
      .run(request_id, digest(job), JSON.stringify(job), now());
    const controller = new AbortController();
    const running = { controller, authorizeAction: input.authorizeAction, work: null };
    active.set(request_id, running);
    running.work = Promise.resolve().then(async () => {
      assertActive(request_id);
      const result = await execute(job, { request_id, signal: controller.signal,
        authorize: (operation, detail) => guard(request_id, operation, detail) });
      assertActive(request_id);
      db.prepare("UPDATE integration_audit_runs SET state='result_ready',result=?,reason=NULL WHERE request_id=? AND state='running' AND stopped=0")
        .run(JSON.stringify(result), request_id);
    }).catch((error) => {
      db.prepare("UPDATE integration_audit_runs SET state='needs_attention',reason=? WHERE request_id=? AND state='running' AND stopped=0")
        .run(typeof error.code === "string" ? error.code : "AUDIT_EXECUTION_UNCONFIRMED", request_id);
    }).finally(() => active.delete(request_id));
    return receipt({ job, request_id }, "running");
  }
  function status(input) {
    const saved = bound(input);
    return receipt(input, saved?.state || "unknown", saved?.reason || null);
  }
  async function cancel(input) {
    const saved = bound(input);
    if (!saved) return receipt(input, "unknown", "RUNTIME_RECEIPT_UNAVAILABLE");
    if (saved.state === "cancelled") return receipt(input, "cancelled");
    const running = active.get(input.request_id);
    db.prepare("UPDATE integration_audit_runs SET stopped=1,state='cancel_pending' WHERE request_id=? AND state!='cancelled'")
      .run(input.request_id);
    if (running) {
      running.controller.abort(fail("RUNTIME_CANCELLED", 403));
      let timer;
      const settled = await Promise.race([running.work.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
      if (!settled) {
        db.prepare("UPDATE integration_audit_runs SET state='needs_attention',reason='CANCELLATION_UNCONFIRMED' WHERE request_id=? AND stopped=1")
          .run(input.request_id);
        return status(input);
      }
    } else if (saved.state !== "result_ready") {
      db.prepare("UPDATE integration_audit_runs SET state='needs_attention',reason='CANCELLATION_UNCONFIRMED' WHERE request_id=? AND stopped=1")
        .run(input.request_id);
      return status(input);
    }
    db.prepare("UPDATE integration_audit_runs SET state='cancelled',reason=NULL WHERE request_id=? AND stopped=1").run(input.request_id);
    return status(input);
  }
  function result(input) {
    const saved = bound(input);
    need(saved?.result, "RESULT_UNAVAILABLE", 409);
    return { ...receipt(input, saved.state, saved.reason), result: JSON.parse(saved.result) };
  }
  return { check: (input) => readHealth(input), start, status, cancel, result,
    authorize(job, operation, detail = null) {
      const current = db.prepare("SELECT request_id FROM integration_audit_runs WHERE job_hash=?").get(digest(job));
      need(current, "RUNTIME_JOB_UNAVAILABLE", 403);
      return guard(current.request_id, operation, detail);
    },
    pending: () => db.prepare("SELECT request_id,job,state,reason FROM integration_audit_runs WHERE state IN ('running','needs_attention')")
      .all().map((saved) => ({ ...saved, job: JSON.parse(saved.job) })),
    async idle() { await Promise.all([...active.values()].map((running) => running.work)); },
    async close() {
      await Promise.all([...active.keys()].map((key) => cancel({ request_id: key, job: JSON.parse(row(key).job) })));
      need(!active.size, "RUNTIME_STOP_UNCONFIRMED", 503);
    },
  };
}
