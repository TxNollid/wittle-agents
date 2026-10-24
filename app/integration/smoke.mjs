import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createFixture } from "./fixtures.mjs";
import { createIntegrationServer } from "./server.mjs";

let fixture = await createFixture({ paidFeasible: false });
const directory = fixture.directory;
let served;
async function open() {
  served = createIntegrationServer(fixture.app, { ...fixture.tokens, fixture, automatic: false });
  await new Promise((resolve, reject) => { served.server.once("error", reject); served.server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${served.server.address().port}`;
}
let base = await open();
async function post(path, input, token = fixture.tokens.operatorToken, extraHeaders = {}) {
  const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extraHeaders }, body: JSON.stringify(input) });
  return { status: response.status, value: await response.json() };
}
try {
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.phase, "free_scoping"); assert.equal(health.mode, "fixture");
  assert.equal(health.sales_enabled, false); assert.equal(health.provider_acceptance, false);
  assert.match(health.build.sha256, /^[a-f0-9]{64}$/);
  const unauthorized = await post("/entry", { request_id: "fixture_entry_a_001" }, "not-an-allocation-token", { "X-Wittle-Entry-Principal": "fixture_browser_a" });
  assert.equal(unauthorized.status, 401);
  const entered = await post("/entry", { request_id: "fixture_entry_a_001" }, fixture.tokens.allocationToken,
    { "X-Wittle-Entry-Principal": "fixture_browser_a" });
  assert.equal(entered.status, 200); assert.equal(entered.value.mode, "fixture"); assert.equal(entered.value.room_id, "fixture_room_a");
  const ready = await fetch(base + "/readiness", { headers: { Authorization: `Bearer ${fixture.tokens.allocationToken}` } });
  const readiness = await ready.json(); assert.equal(ready.status, 200); assert.equal(readiness.entry_available, true); assert.equal(readiness.quoting_available, false);
  const greeting = { buyer: "a", text: "Hello", id: "smoke_free_greeting_a" };
  const first = await post("/fixture/event", greeting);
  assert.equal(first.status, 200); assert.equal(first.value.state, "scoping"); assert.equal(first.value.replies_used, 1);
  assert.equal(fixture.provider.generations(), 1); assert.equal(fixture.provider.messages.size, 1);
  const replay = await post("/fixture/event", greeting);
  assert.deepEqual(replay, first); assert.equal(fixture.provider.generations(), 1); assert.equal(fixture.provider.messages.size, 1);
  const draft = await post("/fixture/event", { buyer: "a", text: "Please audit https://example.com/ for clarity and mobile usability.", id: "smoke_free_scope_a" });
  assert.equal(draft.status, 200); assert.equal(draft.value.brief.site_url, "https://example.com/");
  assert.deepEqual(draft.value.brief.pages, ["https://example.com/"]);
  const agreement = await post("/fixture/event", { buyer: "a", text: "yes", id: "smoke_free_agreement_a" });
  assert.equal(agreement.status, 200); assert.equal(agreement.value.state, "agreed"); assert.equal(agreement.value.scope_agreed, true);
  assert.equal(agreement.value.quote, null); assert.equal(agreement.value.scope_hash, draft.value.scope_hash);
  assert.equal(agreement.value.replies_used, 3); assert.equal(fixture.provider.generations(), 2);
  const before = fixture.provider.messages.size;
  const forged = { ...fixture.provider.events.get("smoke_free_scope_a"), text: "A forged source must not mutate the brief" };
  const denied = await post("/events/rooms", forged, fixture.tokens.backendToken);
  assert.equal(denied.status, 403); assert.equal(fixture.provider.messages.size, before);
  const other = await post("/api/brief", {}, fixture.tokens.backendToken, { "X-Wittle-Room-Capability": fixture.capabilities.b });
  assert.equal(other.status, 200); assert.equal(other.value, null);
  const anonymous = await post("/api/brief", {}, fixture.tokens.backendToken, { "X-Wittle-Entry-Principal": "fixture_browser_a" });
  assert.equal(anonymous.status, 403);
  const quoteDenied = await post("/api/quote", {}, fixture.tokens.backendToken, { "X-Wittle-Room-Capability": fixture.capabilities.a });
  const paymentDenied = await post("/fixture/payment", { quote_id: "not-a-sale" });
  assert.equal(quoteDenied.status, 503); assert.equal(paymentDenied.status, 503);
  assert.equal(fixture.provider.checkouts.size, 0); assert.equal(fixture.provider.payments.size, 0);
  const fingerprint = served.fingerprint.sha256;
  await served.close(); served = null;
  fixture = await createFixture({ directory, paidFeasible: false }); base = await open();
  const restored = await post("/api/brief", {}, fixture.tokens.backendToken, { "X-Wittle-Room-Capability": fixture.capabilities.a });
  assert.equal(restored.status, 200); assert.equal(restored.value.scope_agreed, true);
  assert.equal(restored.value.scope_hash, agreement.value.scope_hash); assert.equal(restored.value.replies_used, 3);
  const old = await post("/fixture/event", greeting); assert.deepEqual(old, first);
  assert.equal(fixture.provider.generations(), 2); assert.equal(fixture.provider.messages.size, 3);
  const sameEntry = await post("/entry", { request_id: "fixture_entry_a_001" }, fixture.tokens.allocationToken,
    { "X-Wittle-Entry-Principal": "fixture_browser_a" });
  assert.deepEqual(sameEntry, entered);
  assert.equal(served.fingerprint.sha256, fingerprint);
  console.log(JSON.stringify({ state: "pass", scenario: "actual HTTP + durable SQLite free scoping", mode: "fixture", build: fingerprint,
    checks: ["server-only entry token", "allocated same room", "entry true while quoting false", "first reply", "source replay no extra inference/send",
      "saved draft", "independently saved free agreement", "forged source rejected", "other buyer cannot read brief", "browser principal is not buyer authority",
      "checkout and payment disabled", "reopen preserves agreement/quota/source receipt", "exact entry retry after reopen"],
    synthetic_generations: 2, simulated_room_messages: 3, real_model_calls: 0, real_rooms_calls: 0, real_payment_calls: 0,
    human_browser_uat: "not_ready_missing_real_bindings", public_sales_enabled: false }, null, 2));
} finally {
  if (served) await served.close();
  rmSync(directory, { recursive: true, force: true });
}
