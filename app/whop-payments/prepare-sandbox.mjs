// Prepare a real Whop sandbox quote. Human approval is an explicit later action.
import { loadConfig, root } from "./server.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const config = loadConfig(),
  origin = "http://127.0.0.1:" + (config.PAYMENTS_PORT || 3210),
  file = join(root, ".payments/quote-scenario.json");
mkdirSync(join(root, ".payments"), { recursive: true, mode: 0o700 });
let state;
try {
  state = JSON.parse(readFileSync(file));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  state = { scenario_id: randomUUID() };
}
const save = () =>
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
save();
const api = async (path, body, token = config.PAYMENTS_SERVICE_TOKEN) => {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${result.error}`);
  return result;
};
for (const [role, kind] of [
  ["buyer", "human"],
  ["seller", "agent"],
])
  if (!state[role]) {
    state[role] = await api("/api/principals", {
      id: "sandbox-" + role + "-" + state.scenario_id,
      role,
      kind,
    });
    save();
  }
if (!state.service) {
  state.service = await api("/api/services", {
    id: "sandbox-auditor-" + state.scenario_id,
    seller_id: state.seller.id,
    service_version: "sandbox-v1",
    account_id: config.WHOP_COMPANY_ID,
    product_id: config.WHOP_PRODUCT_ID,
    plan_id: config.WHOP_PLAN_ID,
    amount_minor: Number(config.WHOP_PRICE) * 100,
    currency: "usd",
    execution_cap_minor: 500,
  });
  save();
}
if (!state.quote) {
  state.quote = await api(
    "/api/quotes",
    {
      service_id: state.service.id,
      buyer_id: state.buyer.id,
      request_id: state.scenario_id,
      expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
      scope: {
        title: "Wittle payment workflow test",
        deliverables: [
          "One verified sandbox payment receipt and a queued project handoff",
        ],
        acceptance_checks: [
          "Exact approved quote is bound to the payment",
          "Duplicate events create one project task",
        ],
        exclusions: [
          "No real website audit",
          "No production charges",
          "No external customer invitation",
        ],
        required_inputs: [],
        revisions: 0,
        refund_terms: "Fake-money sandbox test; no real product purchase",
        delivery_timing:
          "Receipt after verified sandbox payment; live Rooms setup waits for a connected adapter",
        permitted_recipients: [state.buyer.id, state.seller.id],
        allowed_actions: [],
      },
    },
    state.seller.token,
  );
  save();
}
if (process.argv[2] === "--approve") {
  if (process.argv[3] !== state.quote.hash)
    throw new Error("Supply the exact reviewed quote hash with --approve.");
  await api(
    "/api/quotes/" + state.quote.id + "/approve",
    { quote_hash: state.quote.hash, expected_version: state.quote.version },
    state.buyer.token,
  );
  state.order = await api(
    "/api/checkout",
    {
      quote_id: state.quote.id,
      quote_hash: state.quote.hash,
      request_id: state.scenario_id,
    },
    state.buyer.token,
  );
  save();
  console.log(
    JSON.stringify(
      {
        order_id: state.order.id,
        state: state.order.workflow_status,
        purchase_url: state.order.purchase_url,
      },
      null,
      2,
    ),
  );
} else
  console.log(
    JSON.stringify(
      {
        quote_id: state.quote.id,
        quote_hash: state.quote.hash,
        scope: state.quote.snapshot.scope,
        amount_minor: state.quote.snapshot.amount_minor,
        currency: state.quote.snapshot.currency,
        state: "awaiting_human_approval",
        approve_command:
          "npm run sandbox:prepare -- --approve " + state.quote.hash,
      },
      null,
      2,
    ),
  );
