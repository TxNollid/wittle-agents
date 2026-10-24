const modes = ["fixture", "sandbox", "live"];
const evidenceLevels = [
  "fixture",
  "local_execution",
  "provider",
  "external_customer",
];
const classifications = ["internal", "confirmed_external", "unknown"];
export const eventLabels = Object.freeze({
  lead_saved: "Lead saved",
  draft_saved: "Teaser draft saved",
  post_published: "Feedback reply published",
  room_opened: "Private room opened",
  quote_issued: "Scope quoted",
  payment_verified: "Payment verified",
  refund_verified: "Refund verified",
  audit_delivered: "Audit delivered",
  rating_recorded: "Buyer rating recorded",
  scoping_paused: "Scoping paused",
  intervention_recorded: "Human intervention recorded",
});
const roleEvents = {
  growth: ["lead_saved", "draft_saved", "post_published"],
  rooms: ["room_opened"],
  payments: ["quote_issued"],
  host: ["scoping_paused"],
  operator: ["intervention_recorded"],
};
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const timestamp = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}T.*Z$/.test(s) &&
  Number.isFinite(Date.parse(s));
const id = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(s);
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
const amountGroup = (complete) => ({
  gross_minor: 0,
  refunded_minor: 0,
  net_minor: 0,
  pending_minor: complete ? 0 : null,
  disputed_minor: complete ? 0 : null,
});
const unique = (rows, key) => {
  const result = new Map();
  for (const row of rows) {
    need(id(row[key]), "Invalid source identity");
    if (result.has(row[key]))
      need(
        JSON.stringify(result.get(row[key])) === JSON.stringify(row),
        "Conflicting source identity",
      );
    else result.set(row[key], row);
  }
  return [...result.values()];
};

// actor is supplied by server authentication, not by the model/event payload.
// The payment owner persists accepted rows with a UNIQUE event_id; this is not a store.
export function validateActivityEvent(actor, event) {
  need(
    actor?.verified === true && roleEvents[actor.role]?.includes(event?.type),
    "Event operation forbidden",
  );
  need(
    id(event.event_id) &&
      modes.includes(event.mode) &&
      timestamp(event.occurred_at) &&
      evidenceLevels.includes(actor.evidence_level),
    "Invalid event",
  );
  return {
    event_id: event.event_id,
    type: event.type,
    mode: event.mode,
    occurred_at: event.occurred_at,
    evidence_level: actor.evidence_level,
  };
}

// Only authoritative server snapshots belong here. No public financial ingestion.
// Payment owner establishes provider verification/classification before calling.
export function projectPublicStats(
  {
    mode,
    evidence_level = "provider",
    last_success_at,
    ledger = [],
    ledger_complete = false,
    activity = [],
    results = [],
    ratings = [],
    terac = { state: "blocked", v1: null, v2: null },
  },
  now = new Date(),
) {
  need(
    modes.includes(mode) && evidenceLevels.includes(evidence_level),
    "Invalid evidence environment",
  );
  need(
    timestamp(last_success_at) &&
      Date.parse(last_success_at) <= now.getTime() + 5000,
    "Invalid success timestamp",
  );
  const revenue = {
    currency: "USD",
    external_live: amountGroup(ledger_complete),
    internal_live: amountGroup(ledger_complete),
    unknown_live: amountGroup(ledger_complete),
    sandbox: amountGroup(ledger_complete),
  };
  const paid = new Set(),
    events = [];
  for (const row of unique(ledger, "payment_id")) {
    need(
      ["sandbox", "live"].includes(row.environment) &&
        classifications.includes(row.customer_classification),
      "Invalid ledger classification",
    );
    need(
      integer(row.gross_minor) &&
        integer(row.refunded_minor) &&
        row.refunded_minor <= row.gross_minor &&
        row.currency === "USD",
      "Invalid ledger amount",
    );
    need(id(row.order_id) && timestamp(row.at), "Invalid ledger order");
    if (row.provider_verified !== true) continue;
    const group =
      row.environment === "sandbox"
        ? revenue.sandbox
        : row.customer_classification === "confirmed_external"
          ? revenue.external_live
          : row.customer_classification === "internal"
            ? revenue.internal_live
            : revenue.unknown_live;
    if (row.state === "pending") {
      if (ledger_complete) group.pending_minor += row.gross_minor;
      continue;
    }
    if (!["paid", "refunded", "disputed"].includes(row.state)) continue;
    if (ledger_complete && row.state === "disputed")
      group.disputed_minor += row.gross_minor - row.refunded_minor;
    group.gross_minor += row.gross_minor;
    group.refunded_minor += row.refunded_minor;
    group.net_minor += row.gross_minor - row.refunded_minor;
    if (row.environment === mode || mode === "fixture") {
      paid.add(row.order_id);
      events.push({
        event_id: `receipt_${row.payment_id}`,
        type: "payment_verified",
        mode,
        occurred_at: row.at,
        evidence_level,
      });
      if (row.refunded_minor)
        events.push({
          event_id: `refund_${row.payment_id}`,
          type: "refund_verified",
          mode,
          occurred_at: row.at,
          evidence_level,
        });
    }
  }
  for (const event of unique(activity, "event_id")) {
    need(
      Object.values(roleEvents).flat().includes(event.type) &&
        modes.includes(event.mode) &&
        timestamp(event.occurred_at) &&
        evidenceLevels.includes(event.evidence_level),
      "Invalid persisted activity",
    );
    if (event.mode === mode)
      events.push({
        event_id: event.event_id,
        type: event.type,
        mode,
        occurred_at: event.occurred_at,
        evidence_level: event.evidence_level,
      });
  }
  const delivered = new Set();
  for (const result of unique(results, "result_id")) {
    need(
      id(result.order_id) &&
        modes.includes(result.mode) &&
        timestamp(result.at),
      "Invalid delivery",
    );
    if (
      result.persisted !== true ||
      !paid.has(result.order_id) ||
      result.mode !== mode
    )
      continue;
    delivered.add(result.order_id);
    events.push({
      event_id: result.result_id,
      type: "audit_delivered",
      mode,
      occurred_at: result.at,
      evidence_level,
    });
  }
  const attributableRatings = unique(ratings, "order_id").filter(
    (row) =>
      row.buyer_verified === true &&
      row.mode === mode &&
      delivered.has(row.order_id) &&
      Number.isInteger(row.score) &&
      row.score >= 1 &&
      row.score <= 5,
  );
  const count = (type) => events.filter((e) => e.type === type).length;
  return validatePublicStats({
    schema_version: "wa-v2.1",
    mode,
    evidence_level,
    as_of: now.toISOString(),
    last_success_at,
    stale: now.getTime() - Date.parse(last_success_at) > 30000,
    counts: {
      leads: count("lead_saved"),
      drafts: count("draft_saved"),
      posts: count("post_published"),
      rooms_opened: count("room_opened"),
      quotes: count("quote_issued"),
      paid_orders: paid.size,
      deliveries: delivered.size,
    },
    revenue,
    ratings: {
      count: attributableRatings.length,
      average: attributableRatings.length
        ? attributableRatings.reduce((n, r) => n + r.score, 0) /
          attributableRatings.length
        : null,
    },
    interventions: count("intervention_recorded"),
    terac,
    events: events
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
      .slice(0, 20),
  });
}

// Rebuild from safe fields. Source IDs are replaced with safe feed-local identities;
// arbitrary buyer/room IDs, private URLs, free text and event payloads never escape.
export function validatePublicStats(value) {
  need(
    value?.schema_version === "wa-v2.1" &&
      modes.includes(value.mode) &&
      evidenceLevels.includes(value.evidence_level),
    "Invalid public stats",
  );
  need(
    typeof value.stale === "boolean" &&
      timestamp(value.as_of) &&
      (value.last_success_at === null || timestamp(value.last_success_at)),
    "Invalid stats freshness",
  );
  need(
    value.mode !== "fixture" || value.evidence_level === "fixture",
    "Fixture evidence mismatch",
  );
  const counts = {};
  for (const key of [
    "leads",
    "drafts",
    "posts",
    "rooms_opened",
    "quotes",
    "paid_orders",
    "deliveries",
  ]) {
    need(integer(value.counts?.[key]), "Invalid counts");
    counts[key] = value.counts[key];
  }
  need(value.revenue?.currency === "USD", "Invalid currency");
  const revenue = { currency: "USD" };
  for (const key of [
    "external_live",
    "internal_live",
    "unknown_live",
    "sandbox",
  ]) {
    const group = value.revenue[key];
    need(
      integer(group?.gross_minor) &&
        integer(group?.refunded_minor) &&
        Number.isSafeInteger(group?.net_minor) &&
        group.gross_minor - group.refunded_minor === group.net_minor,
      "Invalid revenue",
    );
    need(
      ["pending_minor", "disputed_minor"].every(
        (field) => group[field] === null || integer(group[field]),
      ),
      "Invalid unresolved amount",
    );
    revenue[key] = {
      gross_minor: group.gross_minor,
      refunded_minor: group.refunded_minor,
      net_minor: group.net_minor,
      pending_minor: group.pending_minor,
      disputed_minor: group.disputed_minor,
    };
  }
  need(
    integer(value.ratings?.count) &&
      ((value.ratings.count === 0 && value.ratings.average === null) ||
        (value.ratings.count > 0 &&
          Number.isFinite(value.ratings.average) &&
          value.ratings.average >= 1 &&
          value.ratings.average <= 5)),
    "Invalid rating",
  );
  need(
    integer(value.interventions) && Array.isArray(value.events),
    "Invalid activity",
  );
  const events = value.events.slice(0, 20).map((event, index) => {
    need(
      Object.hasOwn(eventLabels, event.type) &&
        modes.includes(event.mode) &&
        timestamp(event.occurred_at) &&
        evidenceLevels.includes(event.evidence_level),
      "Invalid public event",
    );
    need(
      event.mode === value.mode &&
        (value.mode === "fixture"
          ? event.evidence_level === "fixture"
          : event.evidence_level !== "fixture"),
      "Mixed evidence feed",
    );
    return {
      event_id: `public_event_${index}`,
      type: event.type,
      mode: event.mode,
      occurred_at: new Date(event.occurred_at).toISOString(),
      evidence_level: event.evidence_level,
    };
  });
  need(
    ["blocked", "prepared", "incomplete", "complete"].includes(
      value.terac?.state,
    ),
    "Invalid Terac state",
  );
  const terac = { state: value.terac.state, v1: null, v2: null };
  for (const version of ["v1", "v2"]) {
    const v = value.terac[version];
    if (v === null) continue;
    need(
      integer(v?.reports) &&
        v.reports > 0 &&
        integer(v.responses) &&
        v.responses > 0 &&
        ["usefulness_mean", "clarity_mean"].every(
          (k) => Number.isFinite(v[k]) && v[k] >= 1 && v[k] <= 7,
        ) &&
        integer(v.would_pay_yes) &&
        integer(v.would_pay_total) &&
        v.would_pay_total > 0 &&
        v.would_pay_yes <= v.would_pay_total,
      "Invalid Terac score",
    );
    terac[version] = {
      reports: v.reports,
      responses: v.responses,
      usefulness_mean: v.usefulness_mean,
      clarity_mean: v.clarity_mean,
      would_pay_yes: v.would_pay_yes,
      would_pay_total: v.would_pay_total,
    };
  }
  need(
    terac.state !== "complete" || (terac.v1 && terac.v2),
    "Incomplete Terac comparison",
  );
  return {
    schema_version: "wa-v2.1",
    mode: value.mode,
    evidence_level: value.evidence_level,
    as_of: new Date(value.as_of).toISOString(),
    last_success_at:
      value.last_success_at === null
        ? null
        : new Date(value.last_success_at).toISOString(),
    stale: value.stale,
    counts,
    revenue,
    ratings: { count: value.ratings.count, average: value.ratings.average },
    interventions: value.interventions,
    terac,
    events,
  };
}
