import "server-only";
import { projectPublicStats } from "@wittle/stats";
import { fixtureStats, fixtureScenarios } from "@wittle/stats/fixtures";
import { adapterURL, webMode } from "./entry.mjs";
let lastSuccess = null,
  lastAttempt = 0,
  inflight = null,
  failedRefresh = false;
export async function getStats() {
  const mode = webMode();
  if (mode === "fixture" && !process.env.WITTLE_STATS_URL) {
    const scenario = fixtureScenarios.includes(
      process.env.WITTLE_FIXTURE_SCENARIO,
    )
      ? process.env.WITTLE_FIXTURE_SCENARIO
      : "sandbox";
    return {
      data: fixtureStats(scenario),
      mode,
      state: scenario,
      refresh_failed: scenario === "failed",
    };
  }
  if (inflight) return inflight;
  if (Date.now() - lastAttempt < 10000) return snapshot(mode, failedRefresh);
  inflight = (async () => {
    lastAttempt = Date.now();
    try {
      if (!process.env.WITTLE_STATS_URL || !process.env.WITTLE_STATS_TOKEN)
        throw new Error("Stats adapter unavailable");
      const response = await fetch(adapterURL(process.env.WITTLE_STATS_URL), {
        headers: { Authorization: `Bearer ${process.env.WITTLE_STATS_TOKEN}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Stats adapter unavailable");
      const source = await response.json();
      if (
        source.mode !== mode ||
        (mode === "fixture"
          ? source.evidence_level !== "fixture"
          : !["provider", "external_customer"].includes(source.evidence_level)) ||
        !source.last_success_at ||
        !Array.isArray(source.ledger) ||
        !Array.isArray(source.activity) ||
        typeof source.ledger_complete !== "boolean"
      )
        throw new Error("Stats evidence mismatch");
      const data = projectPublicStats({
        mode: source.mode,
        evidence_level: source.evidence_level,
        last_success_at: source.last_success_at,
        ledger: source.ledger,
        ledger_complete: source.ledger_complete,
        activity: source.activity,
      });
      lastSuccess = data;
      failedRefresh = false;
      return snapshot(mode, false);
    } catch {
      failedRefresh = true;
      return snapshot(mode, true);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
function snapshot(mode, failed) {
  const data = lastSuccess?.mode === mode ? lastSuccess : null;
  const stale =
    failed ||
    !data ||
    Date.now() - Date.parse(data.last_success_at) > 30000 ||
    data.stale;
  return {
    data: data ? { ...data, stale } : null,
    mode,
    state: data ? (stale ? "stale" : "fresh") : "unavailable",
    refresh_failed: failed,
  };
}
