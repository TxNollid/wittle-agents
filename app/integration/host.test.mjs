import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createFixture } from "./fixtures.mjs";

const act = (f, input) => f.app.receiveRoomEvent({ raw: Buffer.from(JSON.stringify(f.event(input))), headers: {} });
const proposal = (brief_update = {}, role = "host") => ({ role, reply: "Fixture scope discussion only.", brief_update, tool_call: null, pause_reason: null });
function cleanup(t, get) {
  t.after(async () => { const f = get(); await f.app.close(); rmSync(f.directory, { recursive: true, force: true }); });
}

test("free agreement is saved without any payment binding and survives reconnect", async (t) => {
  let f = await createFixture(); cleanup(t, () => f);
  const draft = await act(f, { buyer: "a", text: "Please audit https://example.com/", id: "free_draft_a" });
  const agreed = await act(f, { buyer: "a", text: "yes", id: "free_agreed_a" });
  assert.equal(agreed.state, "agreed"); assert.equal(agreed.scope_agreed, true);
  assert.equal(agreed.scope_hash, draft.scope_hash); assert.equal(agreed.quote, null);
  assert.equal(f.provider.checkouts.size, 0); assert.equal(f.provider.generations(), 1);
  const directory = f.directory; await f.app.close(); f = await createFixture({ directory });
  const restored = await f.app.brief(f.capabilities.a);
  assert.equal(restored.scope_agreed, true); assert.equal(restored.replies_used, 2);
  assert.equal(restored.scope_hash, agreed.scope_hash);
  const replay = await act(f, { buyer: "a", text: "yes", id: "free_agreed_a" });
  assert.deepEqual(replay, agreed); assert.equal(f.provider.messages.size, 2); assert.equal(f.provider.generations(), 1);
});

test("saved free agreement cannot bypass paid feasibility through the quote gateway", async (t) => {
  const f = await createFixture({ phase: "paid_candidate", paidFeasible: false }); cleanup(t, () => f);
  await f.app.entry.allocate("fixture_browser", { request_id: "fixture_entry_0001" });
  await act(f, { text: "Please audit https://example.com/", id: "unready_draft_a" });
  const agreed = await act(f, { text: "yes", id: "unready_agreed_a" });
  assert.equal(agreed.scope_agreed, true); assert.equal(agreed.quote, null);
  await assert.rejects(f.app.service.v2.quote(f.capabilities.a, { site_url: agreed.brief.site_url,
    pages: agreed.brief.pages, scope_summary: agreed.brief.scope_summary, findings_cap: agreed.brief.findings_cap,
    request_id: "no_payment_from_free_agreement_001" }), (error) => error.code === "FEASIBILITY_UNAVAILABLE");
  assert.equal(f.provider.checkouts.size, 0);
  assert.equal(f.app.service.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);
});

test("the combined twelve-turn allowance survives role changes and process reopen", async (t) => {
  let calls = 0;
  const overrides = { async proposeScope(state) {
    calls++;
    return proposal({ goal: `Unique fixture requirement ${state.replies_used}` }, state.replies_used % 2 ? "host" : "auditor");
  } };
  let f = await createFixture({ overrides }); cleanup(t, () => f);
  for (let i = 1; i <= 7; i++) await act(f, { text: `Requirement ${i}`, id: `quota_source_${i}` });
  const directory = f.directory; await f.app.close(); f = await createFixture({ directory, overrides });
  let last;
  for (let i = 8; i <= 13; i++) last = await act(f, { text: `Requirement ${i}`, id: `quota_source_${i}` });
  assert.equal(calls, 12); assert.equal(last.replies_used, 12); assert.equal(last.state, "paused");
  assert.equal(last.paused, "quota_exhausted"); assert.equal(last.scope_agreed, false);
  await act(f, { text: "Try a different role to reset the allowance", id: "quota_source_14" });
  assert.equal(calls, 12); assert.equal((await f.app.brief(f.capabilities.a)).remaining, 0);
});

test("three consecutive no-progress exchanges stop additional inference", async (t) => {
  let calls = 0;
  const f = await createFixture({ overrides: { async proposeScope() { calls++; return proposal(); } } }); cleanup(t, () => f);
  for (let i = 1; i <= 4; i++) await act(f, { text: "Still no new requirements", id: `no_progress_${i}` });
  const state = await f.app.brief(f.capabilities.a);
  assert.equal(calls, 3); assert.equal(state.paused, "no_progress"); assert.equal(state.replies_used, 3);
});

test("membership revocation during inference prevents a new room send", async (t) => {
  let f;
  f = await createFixture({ overrides: { async proposeScope() { f.provider.revoke("a"); return proposal({ goal: "Saved draft only" }); } } });
  cleanup(t, () => f);
  await assert.rejects(act(f, { text: "Scope this", id: "revoked_during_parent" }), (error) => error.code === "MEMBERSHIP_UNAVAILABLE");
  assert.equal(f.provider.messages.size, 0);
  await assert.rejects(act(f, { text: "Scope this", id: "revoked_during_parent" }));
  assert.equal(f.provider.messages.size, 0);
});

test("an ambiguous send is not repeated after a source replay or restart", async (t) => {
  let sends = 0;
  const overrides = { async sendHost() { sends++; throw new Error("Synthetic lost acknowledgement after possible send"); } };
  let f = await createFixture({ overrides }); cleanup(t, () => f);
  const input = { text: "Hello", id: "lost_host_ack_a" };
  const result = await act(f, input); assert.equal(result.state, "needs_attention"); assert.equal(sends, 1);
  const directory = f.directory; await f.app.close(); f = await createFixture({ directory, overrides });
  assert.equal((await act(f, input)).state, "needs_attention");
  assert.equal(sends, 1); assert.equal(f.provider.generations(), 1);
  assert.equal((await f.app.brief(f.capabilities.a)).replies_used, 1);
});

test("a different authenticated buyer cannot recover another room's cached source result", async (t) => {
  const f = await createFixture({ overrides: { async verifyRoomEvent({ raw }) { return JSON.parse(raw.toString("utf8")); } } });
  cleanup(t, () => f);
  await act(f, { text: "Private A requirements", id: "global_source_collision" });
  const event = { ...f.event({ buyer: "b", text: "B request", id: "other_source_b" }), id: "global_source_collision" };
  await assert.rejects(f.app.receiveRoomEvent({ raw: Buffer.from(JSON.stringify(event)), headers: {} }),
    (error) => error.code === "SOURCE_EVENT_CONFLICT");
  assert.equal(await f.app.brief(f.capabilities.b), null);
  assert.equal(f.provider.messages.size, 1);
});

test("a yes event predating the presented draft cannot agree that draft", async (t) => {
  const f = await createFixture({ overrides: { async verifyRoomEvent({ raw }) { return JSON.parse(raw.toString("utf8")); } } });
  cleanup(t, () => f);
  await act(f, { text: "Please audit https://example.com/", id: "presented_draft_a" });
  const event = { ...f.event({ text: "yes", id: "earlier_yes_a" }), position: 1 };
  await assert.rejects(f.app.receiveRoomEvent({ raw: Buffer.from(JSON.stringify(event)), headers: {} }),
    (error) => error.code === "SCOPE_AGREEMENT_MISMATCH");
  assert.equal((await f.app.brief(f.capabilities.a)).scope_agreed, false);
  assert.equal(f.provider.checkouts.size, 0);
});

test("a model cannot execute its proposed quote operation in the free-only phase", async (t) => {
  const f = await createFixture({ overrides: { async proposeScope() {
    return { ...proposal(), tool_call: { operation: "quote", arguments: { amount_minor: 1, buyer_id: "someone_else" } } };
  } } }); cleanup(t, () => f);
  await assert.rejects(act(f, { text: "Scope only", id: "forged_model_quote" }), (error) => error.code === "HOST_OPERATION_FORBIDDEN");
  assert.equal(f.provider.checkouts.size, 0); assert.equal(f.provider.messages.size, 0);
  assert.equal((await f.app.brief(f.capabilities.a)).scope_agreed, false);
});
