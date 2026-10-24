import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createEntryAdapter } from "../rooms-entry/index.mjs";
import { createFulfillment, hashOffer as digest } from "../fulfillment/index.mjs";
import { createDelivery } from "../auditor/delivery.mjs";
import { runAudit, auditScope } from "../auditor/audit.mjs";
import { createHost } from "./host.mjs";
import { createAuditRuntime } from "./runtime.mjs";

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const need = (ok, code, status) => { if (!ok) throw fail(code, status); };
const deniedWorkflows = new Set(["cancelled", "needs_attention", "disputed", "legacy_unbound"]);

function privateDatabases(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  need(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077), "PRIVATE_STATE_DIRECTORY_REQUIRED", 503);
  return (name) => {
    const path = join(directory, name);
    try {
      const file = lstatSync(path);
      need(file.isFile() && file.uid === process.getuid() && !(file.mode & 0o077), "PRIVATE_STATE_FILE_REQUIRED", 503);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const db = new DatabaseSync(path); chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;"); return db;
  };
}
function checkMembership(mode, now, job, proof) {
  const at = Date.parse(proof?.verified_at), expiry = Date.parse(proof?.expires_at);
  need(proof?.mode === mode && proof.evidence_level === (mode === "fixture" ? "fixture" : "provider") &&
    proof.buyer_id === job.buyer_id && proof.room_id === job.room_id && proof.revoked_at === null &&
    typeof proof.membership_id === "string" && proof.membership_id.length > 0 &&
    typeof proof.source_event_id === "string" && proof.source_event_id.length > 0 &&
    Number.isFinite(at) && at <= now() && now() - at <= 60000 && expiry > now(), "MEMBERSHIP_UNAVAILABLE", 503);
}

// Trusted backend composition only. All ports/configuration are operator-injected, never HTTP/model input.
export async function createIntegration({ directory, mode, payment, entryOptions = {}, rooms = [], ports, policy,
  operator, now = Date.now }) {
  need(["fixture", "sandbox"].includes(mode), "LIVE_SALES_NOT_AUTHORIZED", 503);
  need(payment?.client && payment.config && operator?.role === "operator", "TRUSTED_PAYMENT_BINDING_REQUIRED", 503);
  need((payment.config.PAYMENT_EVIDENCE_LEVEL === "fixture") === (mode === "fixture"), "EVIDENCE_MODE_MISMATCH", 503);
  const required = ["verifyCapability", "resolveAuthority", "membership", "readReadiness", "verifyRoom", "readRuntime",
    "proposeScope", "feasible", "sendHost", "sendReport", "readBuyerEvent", "verifyRoomEvent", "createAuditAdapter"];
  for (const name of required) need(typeof ports?.[name] === "function", `MISSING_${name.toUpperCase()}_PORT`, 503);
  // The free-scoping sandbox does not need to install or load the Whop SDK.
  const { createService } = await import("../whop-payments/server.mjs");
  const open = privateDatabases(directory);
  const state = open("integration.sqlite"), entryDb = open("entry.sqlite");
  state.exec(`CREATE TABLE IF NOT EXISTS integration_config (id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_delivery_receipts (delivery_key TEXT PRIMARY KEY,receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_revision_requests (order_id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,request TEXT NOT NULL);`);
  const prior = state.prepare("SELECT mode FROM integration_config WHERE id=1").get();
  need(!prior || prior.mode === mode, "PERSISTED_MODE_MISMATCH", 503);
  if (!prior) state.prepare("INSERT INTO integration_config VALUES (1,?)").run(mode);
  const entry = createEntryAdapter(entryDb, { ...entryOptions, mode, enabled: true, liveReleaseApproved: false },
    { now, readReadiness: ports.readReadiness, verifyRoom: ports.verifyRoom });
  if (rooms.length) entry.addRooms(rooms);
  let host, runtime, delivery, fulfillment;
  const service = createService(payment.config, payment.client, join(directory, "payments.sqlite"), {
    now, rooms: ports.rooms, autoReconcile: false, autoProvision: false,
    v2: { verifyCapability: ports.verifyCapability,
      getTerms: async (cap, request) => {
        const current = host.inspect(cap.room_id);
        const feasibility = await ports.feasible({ buyer_id: cap.buyer_id, room_id: cap.room_id, brief: current?.brief });
        const binding = await entry.getRoomBinding(cap.room_id);
        const terms = host.terms(cap, request, policy, feasibility);
        return { ...terms, return_url: binding.join_url,
          expires_at: new Date(Math.min(Date.parse(binding.expires_at), now() + policy.offer_ttl_ms)).toISOString() };
      },
      resolveRoomBinding: (cap) => entry.getRoomBinding(cap.room_id),
    },
  });
  chmodSync(join(directory, "payments.sqlite"), 0o600);
  const controller = service.controller;
  const validMembership = (job, proof) => checkMembership(mode, now, job, proof);
  function validatePaid(job) {
    auditScope(job);
    need(job.mode === mode, "JOB_MODE_MISMATCH", 403);
    const binding = service.v2.loadBinding(job.order_id), offer = binding.offer, accepted = binding.acceptance;
    need(binding.quote_state === "active" && binding.payment_status === "paid" && !deniedWorkflows.has(binding.workflow_status) &&
      binding.quote_id === job.quote_id && binding.quote_hash === job.quote_hash && binding.quote_hash === digest(offer) &&
      offer.buyer_id === job.buyer_id && offer.room_id === job.room_id && offer.service_version === job.service_version &&
      binding.prompt_version === job.prompt_version && digest(offer.scope) === digest(job.scope) &&
      accepted?.source === "verified_payment" && accepted.order_id === job.order_id && accepted.quote_hash === job.quote_hash &&
      accepted.buyer_id === job.buyer_id && accepted.room_id === job.room_id && accepted.environment === offer.environment &&
      (mode === "fixture" || offer.environment === mode), "PAID_JOB_NOT_AUTHORIZED", 403);
    need(controller.principal(job.buyer_id)?.revoked === 0 && controller.principal(offer.seller_id)?.revoked === 0,
      "PRINCIPAL_REVOKED", 403);
    need(!["cancelled", "cancel_pending"].includes(fulfillment.inspect(job.order_id)?.state), "ACTION_REVOKED", 403);
    return binding;
  }
  async function authorizeEvent(event, operation) {
    const cap = await ports.verifyCapability(event.authority, { operation: operation === "quote" ? "quote" : "order_status" });
    const proof = await ports.membership({ buyer_id: event.buyer_id, room_id: event.room_id });
    validMembership(event, proof);
    need(cap?.buyer_id === event.buyer_id && cap.room_id === event.room_id && cap.revoked_at === null &&
      Date.parse(cap.expires_at) > now() && controller.principal(cap.buyer_id)?.revoked === 0, "SOURCE_AUTHORITY_REVOKED", 403);
    return cap;
  }
  async function authorizeRevisionAction(job, input) {
    validatePaid(job);
    const proof = await ports.membership({ buyer_id: job.buyer_id, room_id: job.room_id });
    const health = await runtime.check({ buyer_id: job.buyer_id, room_id: job.room_id, order_id: job.order_id });
    validMembership(job, proof);
    need(health?.mode === mode && health.evidence_level === (mode === "fixture" ? "fixture" : "provider") &&
      health.buyer_id === job.buyer_id && health.room_id === job.room_id && health.inputs_ready === true &&
      health.readiness?.credential_boundary_verified === true && health.readiness.membership_ready === true &&
      health.readiness.host_lead_ready === true && health.readiness.stale === false &&
      Date.parse(health.readiness.observed_at) <= now() && Date.parse(health.readiness.expires_at) > now(),
      "RUNTIME_UNAVAILABLE", 503);
    validatePaid(job); // synchronous final payment/principal/stop barrier after all awaits
    return controller.reserveCost(operator, job.attempt_id, input);
  }
  delivery = createDelivery({ databasePath: join(directory, "reports.sqlite"),
    authorize: async ({ job, operation }) => {
      validatePaid(job);
      await runtime.authorize(job, operation);
      validatePaid(job);
      return { ...job, allowed: true };
    },
    send: async (input) => {
      const receipt = await ports.sendReport(input);
      need(receipt?.room_id === input.room_id && receipt.delivery_key === input.delivery_key &&
        typeof receipt.message_id === "string" && Number.isSafeInteger(receipt.position) && receipt.position > 0,
        "REPORT_RECEIPT_MISMATCH", 503);
      state.prepare("INSERT INTO integration_delivery_receipts VALUES (?,?) ON CONFLICT(delivery_key) DO NOTHING")
        .run(input.delivery_key, JSON.stringify(receipt));
      return receipt;
    },
    readBuyerEvent: ports.readBuyerEvent,
  });
  chmodSync(join(directory, "reports.sqlite"), 0o600);
  async function run(job, context, revisionRequest = null) {
    const adapter = await ports.createAuditAdapter({ job, signal: context.signal });
    try {
      context.signal.throwIfAborted();
      const guarded = { evidence_kind: adapter.evidence_kind,
        async observe(input) {
          await context.authorize("observe", { url: input.url, viewport: input.viewport });
          context.signal.throwIfAborted();
          return adapter.observe({ ...input, signal: AbortSignal.any([context.signal, input.signal]) });
        },
      };
      if (revisionRequest) {
        need(typeof ports.runRevision === "function", "REVISION_EXECUTOR_UNAVAILABLE", 503);
        return await ports.runRevision({ job, request: revisionRequest, previous: readReport(job.order_id, 0), adapter: guarded,
          signal: context.signal });
      }
      return await runAudit(job, guarded);
    } finally { await adapter.close(); }
  }
  function readReport(orderId, revision = 0) {
    const record = delivery.inspect(orderId)?.reports.find((report) => report.revision === revision);
    return record ? JSON.parse(record.payload) : null;
  }
  runtime = createAuditRuntime({ db: state, mode, readHealth: ports.readRuntime, costs: policy.action_cost_minor, now,
    async execute(job, context) {
      let sent;
      if (job.revision === 0) sent = await delivery.fulfill(job, () => run(job, context));
      else {
        const request = state.prepare("SELECT request FROM integration_revision_requests WHERE order_id=?").get(job.order_id);
        need(request, "REVISION_REQUEST_UNAVAILABLE", 503);
        const input = JSON.parse(request.request);
        sent = await delivery.revise(job, input, () => run(job, context, input));
      }
      need(["delivered", "revised"].includes(sent.state), "REPORT_SEND_RECONCILIATION_REQUIRED", 503);
      const records = delivery.records(job.order_id, job.revision);
      need(records?.result && records.delivery, "BOUND_REPORT_RECORDS_UNAVAILABLE", 503);
      need(typeof ports.lifecycle?.completeRun === "function", "CONTROLLER_COMPLETION_UNAVAILABLE", 503);
      const completion = await ports.lifecycle.completeRun({ job, ...records, request_id: `complete_${digest({ order: job.order_id, revision: job.revision })}` });
      context.signal.throwIfAborted();
      return { report: readReport(job.order_id, job.revision), ...records, completion };
    },
  });
  fulfillment = createFulfillment({ db: service.db, controller, operator, mode, now,
    paymentAcceptance: service.v2.paymentAcceptance, membership: ports.membership, runtime });
  host = createHost({ db: state, mode, now, propose: ports.proposeScope, feasible: ports.feasible,
    issueQuote: (event, input) => service.v2.quote(event.authority, input),
    orderStatus: (event, input) => service.v2.orderStatus(event.authority, input),
    send: ports.sendHost, authorize: authorizeEvent });
  async function receiveRoomEvent(input) {
    const event = await ports.verifyRoomEvent(input);
    if (event === null) return { state: "ignored", reason: "not_an_attributable_buyer_message" };
    need(event?.actor_id === event.buyer_id, "SOURCE_ACTOR_MISMATCH", 403);
    await authorizeEvent(event, "scope");
    if (event.kind === "revision") {
      const current = host.inspect(event.room_id);
      need(current?.quote, "REVISION_BEFORE_DELIVERY", 409);
      return revise(event.authority, { quote_id: current.quote.quote_id, event_id: event.id });
    }
    return host.handle(event);
  }
  async function buyerContext(authority, quoteId) {
    const status = await service.v2.orderStatus(authority, { quote_id: quoteId });
    need(status.order_id, "ORDER_UNAVAILABLE", 404);
    const binding = service.v2.loadBinding(status.order_id);
    const proof = await ports.membership({ buyer_id: binding.offer.buyer_id, room_id: binding.offer.room_id });
    validMembership({ buyer_id: binding.offer.buyer_id, room_id: binding.offer.room_id }, proof);
    // Recheck the opaque authority after the awaited membership read. Allocation never supplies buyer identity.
    const latest = await service.v2.orderStatus(authority, { quote_id: quoteId });
    validMembership({ buyer_id: binding.offer.buyer_id, room_id: binding.offer.room_id }, proof);
    need(controller.principal(binding.offer.buyer_id)?.revoked === 0, "PRINCIPAL_REVOKED", 403);
    return { status: latest, binding: service.v2.loadBinding(latest.order_id) };
  }
  async function brief(authority) {
    const cap = await ports.verifyCapability(authority, { operation: "order_status" });
    need(cap, "ROOM_AUTHORITY_REQUIRED", 403);
    await authorizeEvent({ authority, buyer_id: cap.buyer_id, room_id: cap.room_id }, "scope");
    return host.inspect(cap.room_id);
  }
  async function orderStatus(authority, { quote_id }) {
    return (await buyerContext(authority, quote_id)).status;
  }
  async function result(authority, { quote_id, revision = 0 }) {
    need([0, 1].includes(revision), "INVALID_REVISION", 400);
    const { status } = await buyerContext(authority, quote_id);
    const report = readReport(status.order_id, revision);
    need(report, "RESULT_UNAVAILABLE", 404);
    return { mode, evidence_level: mode === "fixture" ? "fixture" : "local_execution", report,
      records: delivery.records(status.order_id, revision), runtime: fulfillment.inspect(status.order_id)?.state || null };
  }
  async function revise(authority, { quote_id, event_id }) {
    const { status, binding } = await buyerContext(authority, quote_id);
    const initial = fulfillment.inspect(status.order_id)?.job;
    need(initial && delivery.records(status.order_id)?.delivery, "REVISION_BEFORE_DELIVERY", 409);
    validatePaid(initial);
    const event = await ports.readBuyerEvent(event_id);
    const records = delivery.records(status.order_id);
    const receipt = state.prepare("SELECT receipt FROM integration_delivery_receipts WHERE delivery_key=?").get(
      delivery.inspect(status.order_id).reports.find((row) => row.revision === 0).delivery_key);
    need(event?.id === event_id && event.actor_id === initial.buyer_id && event.room_id === initial.room_id && event.type === "revision" &&
      Number.isSafeInteger(event.position) && receipt && event.position > JSON.parse(receipt.receipt).position &&
      Array.isArray(event.pages) && event.pages.length > 0 && event.pages.every((page) => initial.scope.pages.includes(page)) &&
      event.in_scope === true && typeof event.instructions === "string" && event.instructions.trim() && event.instructions.length <= 2000,
      "REVISION_EVENT_NOT_ATTRIBUTABLE", 403);
    need(records.delivery.message_id && binding.acceptance, "REVISION_BEFORE_DELIVERY", 409);
    need(typeof ports.lifecycle?.claimRevision === "function" && typeof ports.runRevision === "function", "REVISION_LIFECYCLE_UNAVAILABLE", 503);
    const existing = state.prepare("SELECT * FROM integration_revision_requests WHERE order_id=?").get(initial.order_id);
    need(!existing || existing.event_id === event_id, "REVISION_ALREADY_USED", 409);
    const request = { event_id, pages: event.pages, instructions: event.instructions };
    state.prepare("INSERT OR IGNORE INTO integration_revision_requests VALUES (?,?,?)").run(initial.order_id, event_id, JSON.stringify(request));
    await buyerContext(authority, quote_id);
    validatePaid(initial);
    const run = await ports.lifecycle.claimRevision({ job: initial, event, request_id: `revision_${digest(initial.order_id)}` });
    need(typeof run?.id === "string" && run.id !== initial.attempt_id, "REVISION_ATTEMPT_UNAVAILABLE", 503);
    const job = { ...initial, attempt_id: run.id, revision: 1 };
    return runtime.start({ job, request_id: `revision_${digest(initial.order_id)}`,
      authorizeAction: (input) => authorizeRevisionAction(job, input) });
  }
  let pumping = null, lastDiscovery = -Infinity, stopped = false;
  function tick({ discover = false } = {}) {
    if (pumping) return pumping;
    need(!stopped, "INTEGRATION_STOPPED", 503);
    pumping = (async () => {
      const recovery = discover || now() - lastDiscovery >= 30000 ? await service.reconcilePayments() : null;
      if (recovery) lastDiscovery = now();
      const dispatches = await fulfillment.drain(5);
      for (const dispatch of dispatches) {
        if (["running", "needs_attention"].includes(dispatch.state) && fulfillment.inspect(dispatch.order_id)?.job)
          await fulfillment.reconcile(dispatch.order_id);
      }
      for (const current of runtime.pending()) {
        try { validatePaid(current.job); }
        catch { await runtime.cancel(current); }
      }
      return { recovery, dispatches };
    })().finally(() => { pumping = null; });
    return pumping;
  }
  return { mode, phase: "paid_candidate", policy, service, controller, entry, host, fulfillment, runtime, delivery,
    receiveRoomEvent, result, revise, brief, orderStatus, tick, resolveAuthority: ports.resolveAuthority,
    blockers: () => [!ports.lifecycle?.completeRun && "controller_completion", !ports.lifecycle?.claimRevision && "controller_revision",
      !ports.runRevision && "auditor_revision_executor"].filter(Boolean),
    async close() {
      stopped = true;
      if (pumping) await pumping;
      await runtime.close();
      delivery.close(); service.close(); entryDb.close(); state.close();
    },
  };
}

// Same server and host state, intentionally no Whop client, principal credential, checkout or job runtime.
// This independently runnable phase cannot enable paid work.
export function createFreeScopingIntegration({ directory, mode, rooms = [], entryOptions = {}, ports, now = Date.now }) {
  need(["fixture", "sandbox"].includes(mode), "LIVE_SALES_NOT_AUTHORIZED", 503);
  for (const name of ["verifyCapability", "resolveAuthority", "membership", "readReadiness", "verifyRoom",
    "proposeScope", "sendHost", "verifyRoomEvent"])
    need(typeof ports?.[name] === "function", `MISSING_${name.toUpperCase()}_PORT`, 503);
  const open = privateDatabases(directory);
  const state = open("integration.sqlite"), entryDb = open("entry.sqlite");
  let closed = false;
  state.exec("CREATE TABLE IF NOT EXISTS integration_config (id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL)");
  const prior = state.prepare("SELECT mode FROM integration_config WHERE id=1").get();
  if (prior && prior.mode !== mode) {
    entryDb.close(); state.close(); throw fail("PERSISTED_MODE_MISMATCH", 503);
  }
  if (!prior) state.prepare("INSERT INTO integration_config VALUES (1,?)").run(mode);
  const entry = createEntryAdapter(entryDb, { ...entryOptions, mode, purpose: "free_scoping", enabled: true, liveReleaseApproved: false },
    { now, readReadiness: ports.readReadiness, verifyRoom: ports.verifyRoom });
  if (rooms.length) entry.addRooms(rooms);
  async function authorize(event) {
    need(!closed, "INTEGRATION_STOPPED", 503);
    const cap = await ports.verifyCapability(event.authority, { operation: "order_status" });
    const proof = await ports.membership({ buyer_id: event.buyer_id, room_id: event.room_id });
    checkMembership(mode, now, event, proof);
    need(!closed && cap?.buyer_id === event.buyer_id && cap.room_id === event.room_id &&
      cap.revoked_at === null && Date.parse(cap.expires_at) > now(), "SOURCE_AUTHORITY_REVOKED", 403);
  }
  const host = createHost({ db: state, mode, now, quoteEnabled: false, propose: ports.proposeScope, send: ports.sendHost, authorize });
  return {
    mode, phase: "free_scoping", policy: { purpose: "free_scoping", paid_work_enabled: false }, entry, host,
    resolveAuthority: ports.resolveAuthority, blockers: () => [],
    async receiveRoomEvent(input) {
      need(!closed, "INTEGRATION_STOPPED", 503);
      const event = await ports.verifyRoomEvent(input);
      if (event === null) return { state: "ignored", reason: "not_an_attributable_buyer_message" };
      need(event?.actor_id === event.buyer_id && ["message", "scope_agreed"].includes(event.kind), "SOURCE_ACTOR_MISMATCH", 403);
      await authorize(event);
      return host.handle(event);
    },
    async brief(authority) {
      const cap = await ports.verifyCapability(authority, { operation: "order_status" });
      need(cap, "ROOM_AUTHORITY_REQUIRED", 403);
      await authorize({ authority, buyer_id: cap.buyer_id, room_id: cap.room_id });
      return host.inspect(cap.room_id);
    },
    async close() {
      closed = true;
      await host.idle();
      entryDb.close(); state.close();
    },
  };
}
