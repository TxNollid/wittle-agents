import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEntryAdapter } from "../../app/rooms-entry/index.mjs";
import { createEntryServer } from "../../app/rooms-entry/server.mjs";
import { fixtureRooms, fixturePorts } from "../../app/rooms-entry/fixtures.mjs";
const sources = ["index.mjs", "server.mjs", "fixtures.mjs"];
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash("sha256").update(readFileSync(new URL(`../../app/rooms-entry/${file}`, import.meta.url))).digest("hex")]));
const before = hashes();
function setup(t) {
  const db = new DatabaseSync(":memory:");
  let clock = Date.parse("2026-10-24T18:00:00.000Z");
  const now = () => clock, rooms = fixtureRooms(clock), ports = fixturePorts(rooms, { now });
  const make = (overrides = {}, options = {}) => createEntryAdapter(db, { enabled: true, ...options }, { now, ...ports, ...overrides });
  const adapter = make();
  adapter.addRooms(rooms);
  t.after(() => db.close());
  return { db, now, rooms, ports, adapter, make, advance: ms => { clock += ms; }, count: () => db.prepare("SELECT count(*) n FROM entry_allocations").get().n };
}

test("racing same key with different attribution commits one ref and rejects the loser", async t => {
  const f = setup(t);
  const results = await Promise.allSettled([
    f.adapter.allocate("qa_browser", { request_id: "qa_racing_key", ref: "ref_a" }),
    f.adapter.allocate("qa_browser", { request_id: "qa_racing_key", ref: "ref_b" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "CONFLICT");
  assert.equal(f.count(), 1);
  const binding = f.db.prepare("SELECT * FROM entry_allocations").get();
  const expected = results[0].status === "fulfilled" ? "ref_a" : "ref_b";
  assert.equal(binding.ref, expected);
  await assert.rejects(f.adapter.allocate("other_browser", { request_id: "qa_racing_key", ref: expected }), { code: "FORBIDDEN" });
  assert.equal(f.count(), 1);
});

test("pool import conflict rolls back earlier new entries in the same batch", t => {
  const f = setup(t);
  const room = { ...f.rooms[0], room_id: "qa_extra", join_url: "https://rooms.wittlelabs.ai/opaque/qa-extra" };
  assert.throws(() => f.adapter.addRooms([room, { ...f.rooms[0], room_id: "qa_duplicate_link" }]), { code: "CONFLICT" });
  assert.equal(f.db.prepare("SELECT count(*) n FROM entry_rooms").get().n, 3);
  assert.equal(f.db.prepare("SELECT room_id FROM entry_rooms WHERE room_id='qa_extra'").get(), undefined);
});

test("late read-only provider completion after timeout cannot allocate a room", async t => {
  const f = setup(t), started = Promise.withResolvers(), late = Promise.withResolvers();
  let signal;
  const slow = f.make({ verifyRoom: async (input, options) => {
    signal = options.signal;
    started.resolve();
    await late.promise;
    return f.ports.verifyRoom(input);
  } }, { portTimeoutMs: 20 });
  const pending = assert.rejects(slow.allocate("qa_timeout", { request_id: "qa_timeout_key" }), { code: "RUNTIME_UNAVAILABLE" });
  await started.promise;
  await pending;
  assert.equal(signal.aborted, true);
  late.resolve();
  await Promise.resolve();
  assert.equal(f.count(), 0);
  const result = await f.adapter.allocate("qa_timeout", { request_id: "qa_timeout_key" });
  assert.equal(result.room_id, f.rooms[0].room_id);
  assert.equal(f.count(), 1);
});

test("pool room expiry during read-only proof is rejected without reservation", async t => {
  const f = setup(t);
  const adapter = f.make({ verifyRoom: async input => {
    const proof = await f.ports.verifyRoom(input);
    f.advance(3600001);
    return { ...proof, observed_at: new Date(f.now()).toISOString(), expires_at: new Date(f.now() + 30000).toISOString() };
  } });
  await assert.rejects(adapter.allocate("qa_expiry", { request_id: "qa_expiry_key" }), { code: "RUNTIME_UNAVAILABLE" });
  assert.equal(f.count(), 0);
});

test("HTTP oversized/prototype requests and prefetch expose no private diagnostics or allocations", async t => {
  const f = setup(t), token = "qa-synthetic-entry-secret-not-production";
  const broken = f.make({ verifyRoom: async () => { throw new Error("PRIVATE_CANARY " + f.rooms[0].join_url); } });
  const server = createEntryServer(broken, { token });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/entry`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Wittle-Entry-Principal": "qa_browser" };
  const post = body => fetch(url, { method: "POST", headers, body });
  const oversized = await post(JSON.stringify({ request_id: "qa_http_key", ref: "x".repeat(5000) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { code: "INVALID_INPUT", retryable: false, next_action: "correct_input" });
  const extra = await post('{"request_id":"qa_http_key","__proto__":{"buyer_id":"forged"}}');
  assert.equal(extra.status, 400);
  assert.equal((await fetch(url, { headers: { ...headers, Purpose: "prefetch" } })).status, 405);
  const denied = await post('{"request_id":"qa_http_key"}');
  assert.equal(denied.status, 503);
  assert.equal(denied.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await denied.json(), { code: "RUNTIME_UNAVAILABLE", retryable: true, next_action: "wait" });
  assert.equal(f.count(), 0);
});

after(() => {
  assert.deepEqual(hashes(), before, "Candidate changed during review");
  console.log("QA_ENTRY_SHA256 " + JSON.stringify(before));
});
