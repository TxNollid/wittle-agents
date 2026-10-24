import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  projectPublicStats,
  validateActivityEvent,
  validatePublicStats,
} from "./index.mjs";
const now = new Date("2026-10-24T17:30:00Z");
const payment = (
  id,
  customer,
  environment = "live",
  gross_minor = 1900,
  refunded_minor = 0,
) => ({
  payment_id: id,
  order_id: `order_${id}`,
  customer_classification: customer,
  environment,
  gross_minor,
  refunded_minor,
  currency: "USD",
  provider_verified: true,
  state: refunded_minor ? "refunded" : "paid",
  at: now.toISOString(),
});
const input = (extra) => ({
  mode: "live",
  last_success_at: now.toISOString(),
  ...extra,
});
test("refs cannot turn internal or unknown receipts into external revenue; refunds and duplicate receipts reconcile", () => {
  const external = payment("external", "confirmed_external", "live", 1900, 400);
  const s = projectPublicStats(
    input({
      ledger: [
        external,
        { ...external },
        { ...payment("internal", "internal"), ref: "organic" },
        { ...payment("unknown", "unknown"), ref: "organic" },
        payment("sandbox", "confirmed_external", "sandbox"),
        {
          ...payment("forged", "confirmed_external"),
          provider_verified: false,
        },
      ],
    }),
    now,
  );
  assert.deepEqual(s.revenue.external_live, {
    gross_minor: 1900,
    refunded_minor: 400,
    net_minor: 1500,
    pending_minor: null,
    disputed_minor: null,
  });
  assert.equal(s.revenue.internal_live.net_minor, 1900);
  assert.equal(s.revenue.unknown_live.net_minor, 1900);
  assert.equal(s.revenue.sandbox.net_minor, 1900);
  assert.equal(s.counts.paid_orders, 3);
});
test("forged payment, delivery or rating activity cannot become an authoritative metric", () => {
  for (const type of ["payment_verified", "rating_recorded", "audit_delivered"])
    assert.throws(
      () =>
        validateActivityEvent(
          { verified: true, role: "growth", evidence_level: "provider" },
          {
            event_id: "forged",
            type,
            mode: "live",
            occurred_at: now.toISOString(),
            data: { gross_minor: 999999, score: 5 },
          },
        ),
      /forbidden/,
    );
  assert.throws(
    () =>
      validateActivityEvent(
        { role: "operator", verified: false },
        { type: "intervention_recorded" },
      ),
    /forbidden/,
  );
});
test("projection redacts arbitrary payloads and identifiers; delivery/ratings require persisted buyer evidence", () => {
  const activity = Array.from({ length: 25 }, (_, i) => ({
    event_id: `private_event_${i}`,
    type: "room_opened",
    mode: "live",
    evidence_level: "provider",
    occurred_at: now.toISOString(),
    email: "private@example.com",
    join_url: "https://rooms.wittlelabs.ai/join/private",
    data: { token: "SECRET" },
  }));
  const s = projectPublicStats(
    input({
      ledger: [payment("p", "confirmed_external")],
      activity,
      results: [
        {
          result_id: "r",
          order_id: "order_p",
          mode: "live",
          persisted: true,
          at: now.toISOString(),
        },
        {
          result_id: "fake",
          order_id: "unpaid",
          mode: "live",
          persisted: true,
          at: now.toISOString(),
        },
      ],
      ratings: [
        { order_id: "order_p", mode: "live", buyer_verified: true, score: 4 },
        { order_id: "unpaid", mode: "live", buyer_verified: true, score: 5 },
      ],
    }),
    now,
  );
  assert.equal(s.events.length, 20);
  assert.equal(s.counts.deliveries, 1);
  assert.deepEqual(s.ratings, { count: 1, average: 4 });
  assert.equal(s.counts.rooms_opened, 25);
  assert.doesNotMatch(
    JSON.stringify(s),
    /private|SECRET|email|join_url|token|order_p/,
  );
  assert.equal(validatePublicStats({ ...s, buyer: "SECRET" }).buyer, undefined);
});
test("missing evidence stays unrated; old success stays stale; contradictory receipt snapshots fail closed", () => {
  const s = projectPublicStats(
    input({ last_success_at: "2026-10-24T17:29:00Z" }),
    now,
  );
  assert.equal(s.stale, true);
  assert.deepEqual(s.ratings, { count: 0, average: null });
  assert.throws(
    () =>
      projectPublicStats(
        input({
          ledger: [
            payment("same", "internal"),
            payment("same", "confirmed_external"),
          ],
        }),
        now,
      ),
    /Conflicting/,
  );
  assert.throws(
    () =>
      projectPublicStats(
        input({ ledger: [payment("bad", "internal", "live", 1900, 1901)] }),
        now,
      ),
    /amount/,
  );
});
test("frozen wa-v2.1 stats fixture is accepted, retaining truthful mode and freshness", () => {
  const packet = JSON.parse(
    readFileSync(new URL("../contracts/valid.json", import.meta.url), "utf8"),
  );
  const fixture = packet.cases.find(
    (c) => c.definition === "PublicStats",
  ).payload;
  const clean = validatePublicStats(fixture);
  assert.equal(clean.schema_version, "wa-v2.1");
  assert.equal(clean.mode, fixture.mode);
  assert.equal(clean.last_success_at, fixture.last_success_at);
  assert.deepEqual(clean.revenue, fixture.revenue);
});
test("pending receipts are not paid revenue; disputes remain separately visible only with complete ledger coverage", () => {
  const ledger = [
    { ...payment("pending", "confirmed_external"), state: "pending" },
    { ...payment("disputed", "confirmed_external"), state: "disputed" },
  ];
  const known = projectPublicStats(
    input({ ledger, ledger_complete: true }),
    now,
  );
  assert.equal(known.revenue.external_live.gross_minor, 1900);
  assert.equal(known.revenue.external_live.pending_minor, 1900);
  assert.equal(known.revenue.external_live.disputed_minor, 1900);
  assert.equal(known.counts.paid_orders, 1);
  const partial = projectPublicStats(input({ ledger }), now);
  assert.equal(partial.revenue.external_live.pending_minor, null);
  assert.equal(partial.revenue.external_live.disputed_minor, null);
});
test("activity provenance is retained, and fixtures cannot enter a provider feed", () => {
  const event = {
    event_id: "local_draft",
    type: "draft_saved",
    mode: "live",
    evidence_level: "local_execution",
    occurred_at: now.toISOString(),
  };
  const projected = projectPublicStats(input({ activity: [event] }), now);
  assert.equal(projected.events[0].evidence_level, "local_execution");
  assert.throws(
    () => projectPublicStats(input({ activity: [{ ...event, evidence_level: "fixture" }] }), now),
    /Mixed evidence/,
  );
});
