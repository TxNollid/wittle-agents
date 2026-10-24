// Exercises the running controller without approving the buyer or submitting payment.
import { loadConfig, root } from "./server.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const config = loadConfig(),
  state = JSON.parse(readFileSync(join(root, ".payments/quote-scenario.json"))),
  origin = "http://127.0.0.1:" + (config.PAYMENTS_PORT || 3210),
  checks = [];
const api = async (path, body, token = state.buyer.token) => {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
};
const check = (name, passed, evidence) =>
  checks.push({ name, passed, evidence });
const quote = await api("/api/quotes/" + state.quote.id);
check(
  "Prepared quote is readable only with a party credential",
  quote.status === 200,
  { status: quote.status },
);
const unapproved = await api("/api/checkout", {
  quote_id: state.quote.id,
  quote_hash: state.quote.hash,
  request_id: randomUUID(),
});
check(
  "Real running service blocks unapproved quote",
  unapproved.status === 409,
  { status: unapproved.status },
);
const mismatch = await api("/api/quotes/" + state.quote.id + "/approve", {
  quote_hash: "wrong-hash",
  expected_version: state.quote.version,
});
check("Wrong hash cannot record approval", mismatch.status === 409, {
  status: mismatch.status,
});
const spoof = await api(
  "/api/quotes/" + state.quote.id + "/approve",
  { quote_hash: state.quote.hash, expected_version: state.quote.version },
  config.PAYMENTS_SERVICE_TOKEN,
);
check("Operator cannot impersonate human approval", spoof.status === 403, {
  status: spoof.status,
});
const bad = await api("/api/checkout", null);
check("Malformed body is rejected", bad.status === 400, { status: bad.status });
const forged = await api("/api/webhooks/whop", {
  id: "msg_forged",
  type: "payment.succeeded",
  data: {},
});
check("Unsigned webhook is rejected", forged.status === 401, {
  status: forged.status,
});
const before = quote.body.approvals?.length;
await api("/checkout-complete?paid=true");
const after = await api("/api/quotes/" + state.quote.id);
check(
  "Browser return cannot approve quote",
  before === after.body.approvals?.length,
  { approvals: after.body.approvals?.length },
);
const report = {
  checked_at: new Date().toISOString(),
  mode: "RUNNING_CONTROLLER",
  submitted_payment: false,
  buyer_approved: false,
  checks,
};
writeFileSync(
  new URL("../../sandbox/whop-controller-live-smoke.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = checks.some((x) => !x.passed) ? 1 : 0;
