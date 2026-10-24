import { projectPublicStats } from "./index.mjs";
export const fixtureScenarios = [
  "empty",
  "sandbox",
  "stale",
  "unavailable",
  "failed",
  "pending",
];
export function fixtureStats(scenario = "sandbox", now = new Date()) {
  if (["unavailable", "failed", "pending"].includes(scenario)) return null;
  const at = new Date(
    now.getTime() - (scenario === "stale" ? 120000 : 5000),
  ).toISOString();
  return projectPublicStats(
    {
      mode: "fixture",
      evidence_level: "fixture",
      last_success_at: at,
      ledger_complete: true,
      ledger:
        scenario === "empty"
          ? []
          : [
              {
                payment_id: "fixture_payment",
                order_id: "fixture_order",
                environment: "sandbox",
                customer_classification: "internal",
                currency: "USD",
                gross_minor: 1900,
                refunded_minor: 0,
                provider_verified: true,
                state: "paid",
                at,
              },
            ],
      activity:
        scenario === "empty"
          ? []
          : [
              {
                event_id: "fixture_room",
                type: "room_opened",
                mode: "fixture",
                evidence_level: "fixture",
                occurred_at: at,
              },
              {
                event_id: "fixture_quote",
                type: "quote_issued",
                mode: "fixture",
                evidence_level: "fixture",
                occurred_at: at,
              },
              {
                event_id: "fixture_intervention",
                type: "intervention_recorded",
                mode: "fixture",
                evidence_level: "fixture",
                occurred_at: at,
              },
            ],
      results:
        scenario === "empty"
          ? []
          : [
              {
                result_id: "fixture_result",
                order_id: "fixture_order",
                mode: "fixture",
                persisted: true,
                at,
              },
            ],
    },
    now,
  );
}
