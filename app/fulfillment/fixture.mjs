// Synthetic provider/runtime fixtures only. Never loads environment files or provider credentials.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../whop-payments/server.mjs";
import { createFulfillment } from "./index.mjs";

export async function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fulfillment-fixture-"));
  const path = join(directory, "fixture.sqlite");
  const operator = { id: "fixture_operator", role: "operator" };
  let clock = Date.parse("2026-10-24T18:00:00.000Z"), service;
  const actions = ["browse_public_pages", "write_audit_report", "deliver_in_bound_room"];
  const config = { WHOP_COMPANY_ID: "biz_fixture", WHOP_PRODUCT_ID: "prod_fixture",
    WHOP_PLAN_ID: "plan_fixture", WHOP_PRICE: "19.00", PAYMENTS_SERVICE_TOKEN: "fixture-only-operator",
    APP_URL: "http://localhost", EXECUTION_BUDGET_MINOR: "1000", PAYMENT_EVIDENCE_LEVEL: "fixture" };
  const payments = new Map(), checkouts = new Map(), remoteRuns = new Map();
  const starts = [], cancels = [];
  const client = { checkoutConfigurations: { async create(input, { idempotencyKey }) {
    if (!checkouts.has(idempotencyKey)) checkouts.set(idempotencyKey,
      { id: "ch_" + checkouts.size, purchase_url: "https://sandbox.whop.com/checkout/fixture/", input });
    return checkouts.get(idempotencyKey);
  } }, payments: { async retrieve({ id }) { return payments.get(id); } } };
  const proof = () => ({ capability_id: "fixture_cap", buyer_id: "fixture_buyer", room_id: "fixture_room",
    agent_id: "fixture_host", job_id: null, operations: ["quote", "order_status"],
    membership_id: "fixture_member", source_event_id: "fixture_join", verified_at: new Date(clock).toISOString(),
    issued_at: new Date(clock).toISOString(), expires_at: new Date(clock + 60000).toISOString(), revoked_at: null });
  const input = { site_url: "https://fixture.example/", scope_summary: "Fixture clarity audit",
    pages: ["https://fixture.example/"], findings_cap: 10, request_id: "fixture_quote_0001" };
  const adapters = { now: () => clock,
    v2: { verifyCapability: async () => proof(), getTerms: async () => ({ service_id: "fixture_service",
      scope: { site_url: input.site_url, scope_summary: input.scope_summary, pages: input.pages,
        findings_cap: input.findings_cap, excluded_pages: [], goal: "Clarity", constraints: [], viewports: ["desktop", "mobile"],
        revisions: 1, deliverables: ["Evidence report"], acceptance_checks: ["Each finding has evidence"],
        exclusions: ["No site edits"], required_inputs: [], allowed_actions: actions,
        delivery_timing: "FIXTURE timing only", refund_terms: "FIXTURE terms only" },
      return_url: "https://rooms.wittlelabs.ai/r/fixture_room", expires_at: new Date(clock + 3600000).toISOString() }) },
    rooms: { async ensureProject() { return { project_id: "fixture_project", room_id: options.wrongRoom ? "other_room" : "fixture_room",
      buyer_access: true, seller_access: true }; } } };
  const open = () => { service = createService(config, client, path, adapters); };
  open();
  try {
    service.controller.register(operator, { id: "fixture_buyer", role: "buyer", kind: "agent" });
    service.controller.register(operator, { id: "fixture_seller", role: "seller", kind: "agent" });
    service.controller.setService(operator, { id: "fixture_service", seller_id: "fixture_seller", service_version: "fixture_v1",
      prompt_version: "fixture_prompt_v1", amount_minor: 1900, currency: "usd", account_id: "biz_fixture",
      product_id: "prod_fixture", plan_id: "plan_fixture", execution_cap_minor: 100, allowed_actions: actions });
    const quote = await service.v2.quote("fixture_authority", input);
    const order = service.db.prepare("SELECT * FROM orders WHERE quote_id=?").get(quote.quote_id);
    const payment = { id: "pay_fixture", account_id: "biz_fixture", product_id: "prod_fixture", plan_id: "plan_fixture",
      checkout_configuration_id: order.checkout_id, currency: "usd", status: "paid", substatus: "succeeded",
      subtotal: { amount: "19.00", currency: "usd" }, total: { amount: "19.00", currency: "usd" },
      metadata: checkouts.get(order.id).input.metadata };
    payments.set(payment.id, payment);
    if (options.paid !== false) await service.reconcile(payment.id);
    const receipt = ({ job, request_id }, state) => ({ state, request_id, job_id: job.job_id,
      attempt_id: job.attempt_id, buyer_id: job.buyer_id, room_id: job.room_id, quote_hash: job.quote_hash });
    const runtime = {
      async check() { return { mode: "fixture", evidence_level: "fixture", buyer_id: "fixture_buyer", room_id: "fixture_room", inputs_ready: true, budget_minor: 100,
        readiness: { observed_at: new Date(clock).toISOString(), expires_at: new Date(clock + 30000).toISOString(),
          stale: false, available_slots: 1, host_lead_ready: true, membership_ready: true,
          credential_boundary_verified: true, entry_available: true, quoting_available: true, reason: null } }; },
      async start(args) {
        starts.push(args);
        await args.authorizeAction({ request_id: "fixture_read_0001", action: "browse_public_pages", amount_minor: 5 });
        const result = receipt(args, "running"); remoteRuns.set(args.request_id, result); return result;
      },
      async status(args) { return remoteRuns.get(args.request_id) || receipt(args, "unknown"); },
      async cancel(args) { cancels.push(args); const result = receipt(args, "cancelled"); remoteRuns.set(args.request_id, result); return result; },
    };
    const f = { get service() { return service; }, get c() { return service.controller; },
      quote, order, payment, runtime, starts, cancels, remoteRuns, receipt, operator, proof,
      now: () => clock, advance: (ms) => { clock += ms; },
      membership: async () => ({ ...proof(), mode: "fixture", evidence_level: "fixture" }),
      make(overrides = {}) { return createFulfillment({ db: service.db, controller: service.controller, operator,
        paymentAcceptance: (id) => service.v2.paymentAcceptance(id), membership: (args) => f.membership(args),
        runtime, mode: "fixture", now: () => clock, retryDelayMs: 100, ...overrides }); },
      reopen() { service.close(); open(); },
      async refund() { payment.refunded_amount = { amount: "19.00", currency: "usd" }; await service.reconcile(payment.id); },
      close() { service.close(); rmSync(directory, { recursive: true, force: true }); },
    };
    return f;
  } catch (error) { service.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
}
