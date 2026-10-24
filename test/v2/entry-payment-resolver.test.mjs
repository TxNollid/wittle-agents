import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEntryAdapter } from "../../app/rooms-entry/index.mjs";
import { fixtureRooms, fixturePorts } from "../../app/rooms-entry/fixtures.mjs";
import { createV2Adapter } from "../../app/whop-payments/v2.mjs";
import { fixture } from "./payment-review-fixture.mjs";

const files = ["rooms-entry/index.mjs", "whop-payments/controller.mjs", "whop-payments/server.mjs", "whop-payments/v2.mjs"];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(new URL(`../../app/${file}`, import.meta.url))).digest("hex")]));
const before = hashes();
async function setup(t) {
  const f = fixture(), db = new DatabaseSync(":memory:");
  t.after(() => { db.close(); f.close(); });
  const rooms = fixtureRooms(f.now());
  rooms[0].join_url = "https://rooms.wittlelabs.ai/j/qa%7Eopaque?claim=a%2fb#private-return";
  const entry = createEntryAdapter(db, { enabled: true }, { now: f.now, ...fixturePorts(rooms, { now: f.now }) });
  entry.addRooms(rooms);
  const allocation = await entry.allocate("qa_browser", { request_id: "qa_trusted_entry" });
  let verifies = 0;
  const options = {
    async verifyCapability(authority) {
      ++verifies;
      if (options.beforeVerify) await options.beforeVerify(verifies);
      if (!f.state.allow || authority !== "qa-authority") return null;
      return { capability_id: "qa_cap", buyer_id: f.template.buyer_id, room_id: allocation.room_id,
        agent_id: "qa_host", job_id: null, operations: ["quote", "order_status"],
        membership_id: "qa_member", source_event_id: "qa_event", revoked_at: null,
        issued_at: new Date(f.now()).toISOString(), verified_at: new Date(f.now()).toISOString(),
        expires_at: new Date(f.now() + 60000).toISOString() };
    },
    async getTerms(cap, requested) {
      return { service_id: f.template.service_id, scope: { ...structuredClone(f.template.scope),
        site_url: requested.site_url, scope_summary: requested.scope_summary, pages: requested.pages, findings_cap: requested.findings_cap },
        expires_at: new Date(f.now() + 3600000).toISOString(), return_url: allocation.join_url };
    },
    resolveRoomBinding: cap => entry.getRoomBinding(cap.room_id),
  };
  // Actual exported gateway + actual service checkout/controller/SQLite. Only external attestations/provider are fixtures.
  const gateway = createV2Adapter({ db: f.service.db, controller: f.c, checkout: f.service.checkout,
    config: { PAYMENT_EVIDENCE_LEVEL: "fixture" }, options, now: f.now });
  return { ...f, entry, allocation, options, quote: () => gateway.quote("qa-authority", f.input) };
}

test("actual trusted entry accessor preserves opaque URL bytes on quote and retry", async t => {
  const f = await setup(t), quote = await f.quote();
  f.advance(1000);
  assert.deepEqual(await f.quote(), quote);
  assert.equal(quote.mode, "fixture");
  assert.equal(f.state.createCalls, 1);
  const order = f.order(quote), snapshot = JSON.parse(order.quote_snapshot);
  assert.equal(f.requests.get(order.id).request.redirect_url, f.allocation.join_url);
  assert.equal(snapshot.return_url, f.allocation.join_url);
  assert.equal(snapshot.room_binding.join_url, f.allocation.join_url);
  assert.equal(f.service.db.prepare("SELECT count(*) n FROM approvals").get().n, 0);
});

for (const [name, patch] of Object.entries({ room: { room_id: "other_room" }, mode: { mode: "sandbox" },
  expiry: { expires_at: "2000-01-01T00:00:00.000Z" }, url: { join_url: "https://rooms.wittlelabs.ai/j/other" } })) {
  test(`trusted resolver ${name} mismatch denies before checkout`, async t => {
    const f = await setup(t), resolve = f.options.resolveRoomBinding;
    f.options.resolveRoomBinding = async cap => ({ ...await resolve(cap), ...patch });
    await assert.rejects(f.quote(), { status: 403 });
    assert.equal(f.state.createCalls, 0);
  });
}

test("lost-response retry cannot downgrade a pinned binding after resolver removal", async t => {
  const f = await setup(t);
  f.state.onCreate = () => { throw new Error("synthetic lost response"); };
  await assert.rejects(f.quote(), /synthetic lost response/);
  delete f.options.resolveRoomBinding;
  f.state.onCreate = null;
  await assert.rejects(f.quote(), { status: 503 });
  assert.equal(f.state.createCalls, 1);
});

test("current buyer membership is independently required after room lookup", async t => {
  const f = await setup(t), resolve = f.options.resolveRoomBinding;
  f.options.resolveRoomBinding = async cap => { const binding = await resolve(cap); f.state.allow = false; return binding; };
  await assert.rejects(f.quote(), { status: 403 });
  assert.equal(f.state.createCalls, 0);
});

test("room binding expiring during final membership lookup cannot create payable checkout", async t => {
  const f = await setup(t);
  f.advance(599995); // The actual persisted allocation has five milliseconds remaining.
  f.options.beforeVerify = n => { if (n === 3) f.advance(6); };
  await assert.rejects(f.quote());
  console.log("QA_BINDING_EXPIRY " + JSON.stringify({ provider_create_calls: f.state.createCalls }));
  assert.equal(f.state.createCalls, 0, "expired private-room binding must block payable provider effect");
});

after(() => {
  assert.deepEqual(hashes(), before, "Candidate changed during composition review");
  console.log("QA_RESOLVER_SHA256 " + JSON.stringify(before));
});
