import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/signup.mjs";
import { normalizeSignup, sanitizeCampaign } from "../signup-fields.mjs";

const origin = "https://wittleagents.com";
function post(body, headers = {}) {
  return new Request(origin + "/api/signup", {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("canonical email makes case/whitespace duplicates identical and rejects malformed or control-bearing input", () => {
  const one = normalizeSignup({ email: "  Example+List@Example.Invalid  " });
  const duplicate = normalizeSignup({ email: "example+list@example.invalid" });
  assert.equal(one.email, duplicate.email);
  for (const email of ["", "missing-at", "a@localhost", "Name <a@example.invalid>", "a\u0000@example.invalid", "x".repeat(255) + "@example.invalid"])
    assert.throws(() => normalizeSignup({ email }));
});

test("campaign storage excludes unrelated/private fields and bounds untrusted values", () => {
  const campaign = sanitizeCampaign({ utm_source: "  demo\r\nsource  ", utm_medium: 5, utm_campaign: "x".repeat(150), email: "private", token: "private", room_id: "private" });
  assert.deepEqual(Object.keys(campaign), ["utm_source", "utm_campaign"]);
  assert.equal(campaign.utm_source, "demo source");
  assert.equal(campaign.utm_campaign.length, 120);
  assert.deepEqual(sanitizeCampaign(["invalid"]), {});
});

test("signup cannot claim a save on invalid input, foreign origin, oversized body or absent storage", async () => {
  delete process.env.DATABASE_URL; // Isolated test worker; never read or copy a real credential.
  const method = await handler.fetch(new Request(origin + "/api/signup"));
  assert.equal(method.status, 405);
  const forbidden = await handler.fetch(post({ email: "unit@example.invalid" }, { origin: "https://unrelated.example" }));
  assert.equal(forbidden.status, 403);
  const malformed = await handler.fetch(post("{broken"));
  assert.equal(malformed.status, 400);
  const oversize = await handler.fetch(post({ email: "x".repeat(5000) }));
  assert.equal(oversize.status, 413);
  const unavailable = await handler.fetch(post({ email: "unit@example.invalid" }));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { saved: false, code: "SIGNUP_UNAVAILABLE" });
  const html = await handler.fetch(post({ email: "unit@example.invalid" }, { accept: "text/html" }));
  assert.equal(html.status, 503);
  assert(!(await html.text()).includes("unit@example.invalid"));
});
