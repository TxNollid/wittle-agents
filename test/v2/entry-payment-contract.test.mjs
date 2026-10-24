import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEntryAdapter } from "../../app/rooms-entry/index.mjs";
import { fixtureRooms, fixturePorts } from "../../app/rooms-entry/fixtures.mjs";
import { fixture } from "./payment-review-fixture.mjs";

// The new contract requires a separate room-binding resolver; trusted terms alone are not attestation.
test("opaque entry URL without the trusted resolver cannot create checkout", async t => {
  const files = ["rooms-entry/index.mjs", "whop-payments/v2.mjs", "whop-payments/controller.mjs", "whop-payments/server.mjs"];
  const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(new URL(`../../app/${file}`, import.meta.url))).digest("hex")]));
  const before = hashes();
  const f = fixture(), db = new DatabaseSync(":memory:");
  t.after(() => {
    f.close(); db.close();
    assert.deepEqual(hashes(), before, "Candidate changed during integration check");
    console.log("QA_ENTRY_PAYMENT_SHA256 " + JSON.stringify(before));
  });
  const rooms = fixtureRooms(f.now()), ports = fixturePorts(rooms, { now: f.now });
  const entry = createEntryAdapter(db, { enabled: true }, { now: f.now, ...ports });
  entry.addRooms(rooms);
  const allocation = await entry.allocate("qa_entry_browser", { request_id: "qa_entry_payment" });
  // In production these ports require current membership/provider provenance; not browser fields.
  f.state.capabilityPatch = { room_id: allocation.room_id };
  f.state.termsPatch = { return_url: allocation.join_url };
  await assert.rejects(f.quote(), { status: 403 });
  assert.equal(f.state.createCalls, 0);
});
