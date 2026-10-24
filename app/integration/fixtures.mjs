// EXPLICIT FIXTURES ONLY: no environment files, real model calls, Rooms mutations or payment calls.
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntegration, createFreeScopingIntegration } from "./index.mjs";
import { createHostProposer } from "../rooms-entry/host-proposal.mjs";
import { createBrowserAdapter } from "../auditor/browser.mjs";
import { fixturePages } from "../auditor/fixtures.mjs";
import { SERVICE_VERSION, PROMPT_VERSION } from "../auditor/audit.mjs";
import { hashOffer as digest } from "../fulfillment/index.mjs";

export const FIXTURE_TOKENS = Object.freeze({ allocationToken: "fixture-allocation-no-real-access-000001",
  backendToken: "fixture-backend-no-real-access-00000001", operatorToken: "fixture-operator-no-real-access-0000001" });
export const FIXTURE_CAPABILITIES = Object.freeze({ a: "fixture-room-proof-a", b: "fixture-room-proof-b" });
const fail = (code, status = 403) => Object.assign(new Error(code), { code, status });

export async function createFixture({ directory = mkdtempSync(join(tmpdir(), "wittle-integration-fixture-")),
  phase = "free_scoping", paidFeasible = true, browserExecutable = process.env.AUDITOR_CHROME_PATH, overrides = {}, now = Date.now } = {}) {
  if (!["free_scoping", "paid_candidate"].includes(phase)) throw fail("INVALID_FIXTURE_PHASE", 400);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "fixture-provider.json");
  if (!existsSync(path) && existsSync(join(directory, "integration.sqlite"))) throw fail("FIXTURE_PROVIDER_STATE_MISSING");
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {
    mode: "fixture", rooms: ["a", "b"].map((name) => ({ room_id: `fixture_room_${name}`,
      join_url: `https://rooms.wittlelabs.ai/join/FIXTURE_${name}?invite=FIXTURE_ONLY_${name}#NOT_A_REAL_ROOM`,
      expires_at: new Date(now() + 7200000).toISOString(), mode: "fixture" })),
    checkouts: [], payments: [], messages: [], events: [], positions: [], revoked: [], generations: 0,
  };
  if (saved.mode !== "fixture") throw fail("FIXTURE_MODE_REQUIRED");
  const checkouts = new Map(saved.checkouts), payments = new Map(saved.payments), messages = new Map(saved.messages),
    events = new Map(saved.events), positions = new Map(saved.positions), revoked = new Set(saved.revoked);
  const persist = () => {
    const value = { ...saved, checkouts: [...checkouts], payments: [...payments], messages: [...messages], events: [...events],
      positions: [...positions], revoked: [...revoked] };
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
  };
  persist();
  let app;
  const identity = (name) => ({ buyer_id: `fixture_buyer_${name}`, room_id: `fixture_room_${name}` });
  const nameFor = ({ buyer_id, room_id }) => ["a", "b"].find((name) => identity(name).buyer_id === buyer_id && identity(name).room_id === room_id);
  const proof = (name) => ({ ...identity(name), capability_id: `fixture_cap_${name}`, agent_id: "fixture_host", job_id: null,
    operations: ["quote", "order_status"], membership_id: `fixture_member_${name}`, source_event_id: `fixture_join_${name}`,
    issued_at: new Date(now()).toISOString(), verified_at: new Date(now()).toISOString(), expires_at: new Date(now() + 60000).toISOString(),
    revoked_at: revoked.has(name) ? new Date(now()).toISOString() : null });
  const bump = (room) => { const next = (positions.get(room) || 0) + 1; positions.set(room, next); return next; };
  const readiness = () => ({ observed_at: new Date(now()).toISOString(), expires_at: new Date(now() + 3600000).toISOString(),
    stale: false, available_slots: app?.service ? Math.max(0, 1 - app.service.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get().n) : 2,
    host_lead_ready: true, membership_ready: true, credential_boundary_verified: true,
    entry_available: true, quoting_available: phase === "paid_candidate", reason: null });
  const client = {
    checkoutConfigurations: { async create(input, { idempotencyKey }) {
      if (!checkouts.has(idempotencyKey)) {
        const id = `fixture_checkout_${checkouts.size + 1}`;
        checkouts.set(idempotencyKey, { id, purchase_url: `https://sandbox.whop.com/checkout/FIXTURE/${id}`, input: structuredClone(input) }); persist();
      }
      return structuredClone(checkouts.get(idempotencyKey));
    } },
    payments: {
      async retrieve({ id }) { if (!payments.has(id)) throw fail("FIXTURE_PAYMENT_NOT_FOUND", 404); return structuredClone(payments.get(id)); },
      async list() { return { data: [...payments.values()].slice(-5).reverse().map((value) => structuredClone(value)), page_info: { has_next_page: false } }; },
    },
  };
  const send = async (input) => {
    if (typeof input.text === "string") {
      const source = events.get(input.source_event_id);
      if (!source || source.room_id !== input.room_id) throw fail("HOST_SOURCE_BINDING_REQUIRED");
    }
    const prior = messages.get(input.delivery_key);
    const payload_hash = digest(input);
    if (prior) {
      if (prior.payload_hash !== payload_hash || prior.receipt.room_id !== input.room_id) throw fail("FIXTURE_SEND_CONFLICT");
      return structuredClone(prior.receipt);
    }
    const receipt = { room_id: input.room_id, delivery_key: input.delivery_key, message_id: `fixture_message_${messages.size + 1}`,
      position: bump(input.room_id) };
    messages.set(input.delivery_key, { receipt, payload_hash, input: structuredClone(input) }); persist(); return receipt;
  };
  const parent = { async generate({ messages }) {
    saved.generations++; persist();
    const context = JSON.parse(messages[1].content);
    const suppliedUrl = context.event.text.includes("https://example.com/");
    const update = suppliedUrl ? { site_url: "https://example.com/", pages: ["https://example.com/"], excluded_pages: [],
      goal: "Fixture clarity and mobile usability", constraints: ["Fixture only; public read-only pages"],
      scope_summary: "FIXTURE narrow document/layout audit; not customer work", findings_cap: 10 } : {};
    return { output: JSON.stringify({ role: "host", reply: suppliedUrl ? "This is fixture scoping, not a live agent or paid service. Please review the draft." :
      "Fixture Host: Which public URL and goal should the draft cover?", brief_update: update, tool_call: null, pause_reason: null }) };
  } };
  const proposers = new Map();
  const ports = {
    async verifyCapability(authority) {
      const name = Object.keys(FIXTURE_CAPABILITIES).find((name) => FIXTURE_CAPABILITIES[name] === authority);
      return name && !revoked.has(name) ? proof(name) : null;
    },
    async resolveAuthority({ capability }) { return Object.values(FIXTURE_CAPABILITIES).includes(capability) ? capability : null; },
    async membership(input) {
      const name = nameFor(input);
      if (!name) throw fail("FIXTURE_MEMBER_UNKNOWN");
      return { ...proof(name), mode: "fixture", evidence_level: "fixture" };
    },
    async readReadiness() { return { mode: "fixture", evidence_level: "fixture", readiness: readiness() }; },
    async verifyRoom({ room_id }) {
      const room = saved.rooms.find((room) => room.room_id === room_id);
      if (!room) throw fail("FIXTURE_ROOM_UNKNOWN");
      return { mode: "fixture", evidence_level: "fixture", room_id, join_url: room.join_url, private: true,
        unused: true, host_lead_ready: true, unexpected_members: false,
        observed_at: new Date(now()).toISOString(), expires_at: new Date(now() + 60000).toISOString() };
    },
    async readRuntime(input) { return { mode: "fixture", evidence_level: "fixture", buyer_id: input.buyer_id, room_id: input.room_id,
      inputs_ready: true, budget_minor: 100, readiness: readiness() }; },
    async proposeScope(state) {
      const name = nameFor(state); if (!name) throw fail("FIXTURE_SCOPE_UNKNOWN");
      if (!proposers.has(name)) proposers.set(name, createHostProposer(parent, { ...identity(name), mode: "fixture",
        prompt_version: "host-v1", system_prompt: "Explicit offline fixture. Ask the missing URL/goal; propose a saved scope only. No tools or payment claims." }));
      return proposers.get(name)(state);
    },
    async feasible({ brief }) { return { ok: paidFeasible, mode: "fixture", evidence_level: "fixture", scope_hash: digest(brief),
      observed_at: new Date(now()).toISOString(), expires_at: new Date(now() + 30000).toISOString() }; },
    sendHost: send, sendReport: send,
    async readBuyerEvent(id) { return structuredClone(events.get(id) || null); },
    async verifyRoomEvent({ raw }) {
      let value; try { value = JSON.parse(raw.toString("utf8")); } catch { throw fail("FIXTURE_SOURCE_INVALID"); }
      const original = events.get(value.id);
      if (!original || digest(original) !== digest(value)) throw fail("SOURCE_EVENT_NOT_VERIFIED");
      return structuredClone(original);
    },
    async createAuditAdapter() { return createBrowserAdapter({ executablePath: browserExecutable, fixturePages }); },
    rooms: { async ensureProject({ order_id, quote }) {
      if (!quote?.offer) throw fail("FIXTURE_BOUND_OFFER_REQUIRED");
      return { project_id: `fixture_project_${order_id}`, room_id: quote.offer.room_id, buyer_access: true, seller_access: true };
    } },
    ...overrides,
  };
  const operator = { id: "fixture_operator", role: "operator" };
  const actions = ["browse_public_pages", "write_audit_report", "deliver_in_bound_room"];
  const policy = { service_id: "fixture_auditor", offer_ttl_ms: 900000,
    delivery_timing: "FIXTURE only; no customer delivery commitment.", refund_terms: "FIXTURE only; no real charge or refund.",
    deliverables: ["Fixture evidence report"], acceptance_checks: ["Every reported finding has matching page/viewport evidence"],
    exclusions: ["No site changes, authenticated pages, SEO/performance guarantees or human expert review"],
    action_cost_minor: Object.fromEntries(actions.map((action) => [action, 1])) };
  if (phase === "free_scoping") app = createFreeScopingIntegration({ directory, mode: "fixture", ports, now, rooms: saved.rooms });
  else {
    app = await createIntegration({ directory, mode: "fixture", operator, ports, policy, now, rooms: saved.rooms,
      payment: { client, config: { WHOP_COMPANY_ID: "biz_fixture", WHOP_PRODUCT_ID: "prod_fixture", WHOP_PLAN_ID: "plan_fixture",
        WHOP_PRICE: "19.00", PAYMENT_EVIDENCE_LEVEL: "fixture", PAYMENTS_SERVICE_TOKEN: FIXTURE_TOKENS.operatorToken,
        APP_URL: "http://127.0.0.1", EXECUTION_BUDGET_MINOR: "1000" } } });
    for (const name of ["a", "b"]) if (!app.controller.principal(identity(name).buyer_id))
      app.controller.register(operator, { id: identity(name).buyer_id, role: "buyer", kind: "agent" });
    if (!app.controller.principal("fixture_seller")) app.controller.register(operator, { id: "fixture_seller", role: "seller", kind: "agent" });
    if (!app.service.db.prepare("SELECT id FROM services WHERE id=?").get(policy.service_id))
      app.controller.setService(operator, { id: policy.service_id, seller_id: "fixture_seller", service_version: SERVICE_VERSION,
        prompt_version: PROMPT_VERSION, amount_minor: 1900, currency: "usd", account_id: "biz_fixture", product_id: "prod_fixture",
        plan_id: "plan_fixture", execution_cap_minor: 100, allowed_actions: actions });
  }
  function event({ buyer = "a", text, kind = "message", scope_hash, pages, instructions, id } = {}) {
    if (!["a", "b"].includes(buyer) || typeof text !== "string" || !text.trim() || text.length > 2000) throw fail("INVALID_FIXTURE_EVENT", 400);
    const fingerprint = digest({ buyer, text, kind, scope_hash: scope_hash || null, pages: pages || null, instructions: instructions || null });
    if (id && events.has(id)) {
      const existing = events.get(id); if (existing.fixture_payload_hash !== fingerprint) throw fail("SOURCE_EVENT_CONFLICT");
      return structuredClone(existing);
    }
    id ||= `fixture_event_${events.size + 1}`;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw fail("INVALID_FIXTURE_EVENT", 400);
    const context = identity(buyer);
    const value = { id, ...context, actor_id: context.buyer_id, kind, text, position: bump(context.room_id),
      authority: FIXTURE_CAPABILITIES[buyer], fixture_payload_hash: fingerprint,
      ...(scope_hash ? { scope_hash } : {}), ...(kind === "revision" ? { type: "revision", pages, instructions, in_scope: true } : {}) };
    events.set(id, value); persist(); return structuredClone(value);
  }
  async function payment({ quote_id, refund = false }) {
    if (!app.service) throw fail("PAID_WORK_DISABLED_FOR_FREE_SCOPING", 503);
    const order = app.service.db.prepare("SELECT * FROM orders WHERE quote_id=?").get(quote_id);
    if (!order || !checkouts.has(order.id)) throw fail("FIXTURE_ORDER_NOT_FOUND", 404);
    let row = [...payments.values()].find((row) => row.metadata.order_id === order.id);
    if (!row) {
      const snapshot = JSON.parse(order.quote_snapshot);
      const amount = (snapshot.amount_minor / 100).toFixed(2);
      row = { id: `pay_fixture${payments.size + 1}`, account_id: snapshot.account_id, product_id: snapshot.product_id, plan_id: snapshot.plan_id,
        checkout_configuration_id: order.checkout_id, currency: "usd", status: "paid", substatus: "succeeded",
        subtotal: { amount, currency: "usd" }, total: { amount, currency: "usd" }, metadata: checkouts.get(order.id).input.metadata };
    }
    if (refund) row.refunded_amount = { ...row.total };
    payments.set(row.id, row); persist();
    return { payment_id: row.id, evidence_level: "fixture", real_charge: false, real_refund: false };
  }
  return { app, directory, tokens: FIXTURE_TOKENS, capabilities: FIXTURE_CAPABILITIES, event, payment,
    provider: { messages, events, payments, checkouts, generations: () => saved.generations,
      revoke(name) { revoked.add(name); persist(); } },
  };
}
