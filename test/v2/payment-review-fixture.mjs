// QA-only local fixture. Real controller/SQLite, synthetic provider and membership adapters.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../../app/whop-payments/server.mjs";
const examples = JSON.parse(readFileSync(new URL("../../app/contracts/valid.json", import.meta.url)));
// Wire fixture IDs are opaque; the legacy catalog additionally requires provider prefixes.
const template = { ...examples.cases.find((row) => row.definition === "Offer").payload,
  product_id: "prod_qa_fixture", plan_id: "plan_qa_fixture" };
export const admin = { id: "operator", role: "operator" };
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wittle-qa-v2-"));
  let clock = Date.parse("2026-10-24T18:00:00.000Z");
  const state = { createCalls: 0, onCreate: null, capabilityPatch: {}, allow: true, termsPatch: {} };
  const requests = new Map(), payments = new Map();
  const config = {
    WHOP_COMPANY_ID: template.company_id, WHOP_PRODUCT_ID: template.product_id, WHOP_PLAN_ID: template.plan_id,
    WHOP_PRICE: "19.00", APP_URL: "http://127.0.0.1", PAYMENTS_SERVICE_TOKEN: "qa-only-synthetic",
  };
  const client = {
    checkoutConfigurations: { async create(request, { idempotencyKey }) {
      state.createCalls++;
      if (state.onCreate) await state.onCreate(request, idempotencyKey);
      if (!requests.has(idempotencyKey)) requests.set(idempotencyKey, {
        id: "ch_" + idempotencyKey.replaceAll("-", ""),
        purchase_url: "https://sandbox.whop.com/checkout/qa-only/", request: structuredClone(request),
      });
      return requests.get(idempotencyKey);
    } },
    payments: { async retrieve({ id }) {
      if (!payments.has(id)) throw new Error("Unknown synthetic payment");
      return structuredClone(payments.get(id));
    } },
  };
  const scope = structuredClone(template.scope);
  const input = { site_url: scope.site_url, scope_summary: scope.scope_summary,
    pages: scope.pages, findings_cap: scope.findings_cap, request_id: "qa_v2_quote_0001" };
  const service = createService(config, client, join(directory, "db.sqlite"), {
    now: () => clock,
    v2: {
      verifyCapability: async (authority) => state.allow && authority === "qa-authority" ? {
        capability_id: "qa_cap", buyer_id: template.buyer_id, room_id: template.room_id, agent_id: "qa_host",
        job_id: null, operations: ["quote", "order_status"], membership_id: "qa_member", source_event_id: "qa_event",
        issued_at: new Date(clock).toISOString(), verified_at: new Date(clock).toISOString(),
        expires_at: new Date(clock + 60000).toISOString(), revoked_at: null, ...state.capabilityPatch,
      } : null,
      getTerms: async (cap, requested) => ({
        service_id: template.service_id, scope: { ...scope, site_url: requested.site_url,
          scope_summary: requested.scope_summary, pages: requested.pages, findings_cap: requested.findings_cap },
        expires_at: new Date(clock + 3600000).toISOString(), return_url: "https://rooms.wittlelabs.ai/r/" + cap.room_id,
        ...state.termsPatch,
      }),
    },
    rooms: { async ensureProject({ quote }) {
      return { project_id: "qa_project", room_id: quote.offer.room_id, buyer_access: true, seller_access: true };
    } },
  });
  const c = service.controller;
  try {
  c.register(admin, { id: template.buyer_id, role: "buyer", kind: "agent" });
  c.register(admin, { id: template.seller_id, role: "seller", kind: "agent" });
  c.setService(admin, {
    id: template.service_id, seller_id: template.seller_id, service_version: template.service_version,
    prompt_version: "auditor-v1", amount_minor: template.amount_minor, currency: "usd",
    account_id: template.company_id, product_id: template.product_id, plan_id: template.plan_id,
    execution_cap_minor: 500, allowed_actions: scope.allowed_actions,
  });
  } catch (error) {
    service.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const quote = (change = {}) => service.v2.quote("qa-authority", { ...input, ...change });
  const order = (q) => service.db.prepare("SELECT * FROM orders WHERE quote_id=?").get(q.quote_id);
  function payment(q, change = {}) {
    const o = order(q);
    const value = { id: "pay_" + o.id.replaceAll("-", ""), account_id: template.company_id,
      product_id: template.product_id, plan_id: template.plan_id, checkout_configuration_id: o.checkout_id,
      metadata: structuredClone(requests.get(o.id).request.metadata), currency: "usd", status: "paid", substatus: "succeeded",
      subtotal: { amount: "19.00", currency: "usd" }, total: { amount: "19.00", currency: "usd" }, ...change };
    payments.set(value.id, value);
    return value;
  }
  return { service, c, client, state, quote, order, payment, requests, payments, input, template,
    now: () => clock, advance: (ms) => { clock += ms; },
    status: (q) => service.v2.orderStatus("qa-authority", { quote_id: q.quote_id }),
    close() { service.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
