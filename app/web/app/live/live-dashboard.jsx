"use client";
import { useEffect, useState } from "react";
import { eventLabels } from "@wittle/stats";
const money = (n) =>
  n === null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(n / 100);
const time = (s) =>
  s
    ? new Date(s).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }) + " ET"
    : "Not available";
export default function LiveDashboard({ initial }) {
  const [snapshot, setSnapshot] = useState(initial);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/stats", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Refresh unavailable");
        const result = await response.json();
        if (active) setSnapshot(result);
      } catch {
        if (active)
          setSnapshot((old) => ({
            ...old,
            state: old.data ? "stale" : "unavailable",
            refresh_failed: true,
          }));
      }
    };
    const timer = setInterval(refresh, 15000);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, []);
  const { data, mode, state, refresh_failed } = snapshot;
  const fixture = mode === "fixture";
  return (
    <>
      <div
        className={`evidence-banner ${fixture ? "fixture" : ""}`}
        role="status"
      >
        <div>
          <strong>
            {fixture
              ? "Fixture data — not real activity"
              : mode === "sandbox"
                ? "Sandbox provider activity — not live sales"
                : "Live provider evidence"}
          </strong>
          <p>
            {fixture
              ? "Every count and event below is a development example. No buyers, reviews or revenue are claimed."
              : state === "stale"
                ? "Last successful data is shown. The feed is stale; totals may have changed."
                : state === "unavailable"
                  ? "The data source is unavailable. Missing values are not zero."
                  : "Only verified provider records contribute to financial and customer metrics."}
          </p>
        </div>
        <span className="badge">
          {state === "sandbox" ? "Fixture scenario" : state}
        </span>
      </div>
      <div className="freshness">
        <span>
          Last successful update:{" "}
          <time suppressHydrationWarning>{time(data?.last_success_at)}</time>
        </span>
        <span>
          {refresh_failed
            ? "Refresh failed · retaining last success"
            : "Checks every 15 seconds"}
        </span>
      </div>
      {!data ? (
        <section className="empty-state">
          <h2>
            {state === "pending"
              ? "Waiting for the first refresh."
              : "No verified totals to show."}
          </h2>
          <p>
            {state === "failed"
              ? "The fixture demonstrates a failed refresh."
              : "The source has not supplied a successful snapshot."}{" "}
            We won’t replace missing data with invented activity.
          </p>
          <a className="text-link" href="/live">
            Refresh this view
          </a>
        </section>
      ) : (
        <>
          <section className="revenue-section">
            <div>
              <h2>
                Confirmed external
                <br />
                live receipts
              </h2>
              <p>
                Only verified live payments from confirmed external buyers.
                Internal and unknown buyers stay separate, even with a referral.
              </p>
              <p className="subtle">
                {fixture
                  ? "Illustrative values below, not actual receipts."
                  : "Net collected is gross minus recorded refunds, not a claim that funds are settled."}
              </p>
            </div>
            <dl className="revenue-values">
              <div>
                <dt>Gross receipts</dt>
                <dd>{money(data.revenue.external_live.gross_minor)}</dd>
              </div>
              <div>
                <dt>Refunds</dt>
                <dd>{money(data.revenue.external_live.refunded_minor)}</dd>
              </div>
              <div>
                <dt>Net collected</dt>
                <dd>{money(data.revenue.external_live.net_minor)}</dd>
              </div>
              <div>
                <dt>Pending payments</dt>
                <dd>{money(data.revenue.external_live.pending_minor)}</dd>
              </div>
              <div>
                <dt>Disputed, not settled</dt>
                <dd>{money(data.revenue.external_live.disputed_minor)}</dd>
              </div>
            </dl>
          </section>
          <section className="dashboard-section">
            <h2>Keep the other activity separate.</h2>
            <div className="table-scroll">
              <table>
                <caption>
                  Receipts by environment and customer classification
                  {fixture ? " — fixtures" : ""}. Unknown means the source has
                  not established the amount.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Classification</th>
                    <th scope="col">Gross</th>
                    <th scope="col">Refunds</th>
                    <th scope="col">Net</th>
                    <th scope="col">Pending</th>
                    <th scope="col">Disputed</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["internal_live", "Internal · live"],
                    ["unknown_live", "Unknown buyer · live"],
                    ["sandbox", "Sandbox · all classifications"],
                  ].map(([key, label]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{money(data.revenue[key].gross_minor)}</td>
                      <td>{money(data.revenue[key].refunded_minor)}</td>
                      <td>{money(data.revenue[key].net_minor)}</td>
                      <td>{money(data.revenue[key].pending_minor)}</td>
                      <td>{money(data.revenue[key].disputed_minor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="dashboard-section">
            <h2>
              {fixture
                ? "Fixture funnel"
                : data.mode === "sandbox"
                  ? "Sandbox funnel"
                  : "Live funnel"}
            </h2>
            <dl className="funnel">
              {[
                ["leads", "Leads"],
                ["drafts", "Drafts"],
                ["posts", "Published replies"],
                ["rooms_opened", "Rooms opened"],
                ["quotes", "Quotes"],
                ["paid_orders", "Paid orders"],
                ["deliveries", "Delivered audits"],
              ].map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{data.counts[key]}</dd>
                </div>
              ))}
            </dl>
          </section>
          <div className="dashboard-columns">
            <section>
              <h2>Recent activity</h2>
              <p className="subtle">
                Up to 20 safe events. No buyer identities, private links,
                transcripts or free-text payloads.
              </p>
              {data.events.length ? (
                <ol className="event-list">
                  {data.events.map((event) => (
                    <li key={event.event_id}>
                      <div>
                        <strong>{eventLabels[event.type]}</strong>
                        <span>
                          {event.mode} · {event.evidence_level}
                        </span>
                      </div>
                      <time suppressHydrationWarning>
                        {time(event.occurred_at)}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-inline">
                  No recorded events in this snapshot.
                </p>
              )}
            </section>
            <aside>
              <section>
                <h2>Buyer ratings</h2>
                <p className="rating">
                  {data.ratings.average === null
                    ? "Not yet available"
                    : `${data.ratings.average.toFixed(1)} / 5`}
                </p>
                <p>
                  {data.ratings.count === 0
                    ? "No verified buyer ratings have been recorded."
                    : `${data.ratings.count} attributable rating${data.ratings.count === 1 ? "" : "s"} in this environment${fixture ? " — fixture only" : ""}.`}
                </p>
              </section>
              <section>
                <h2>Human interventions</h2>
                <p className="rating">{data.interventions}</p>
                <p>
                  Recorded setup or recovery events, not a claim of zero-human
                  operation.
                </p>
              </section>
              <section>
                <h2>Terac improvement loop</h2>
                {data.terac.state === "complete" ? (
                  <div className="table-scroll">
                    <table>
                      <caption>
                        Completed comparison{fixture ? " — fixture only" : ""}
                      </caption>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>v1</th>
                          <th>v2</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          ["reports", "Reports"],
                          ["responses", "Responses"],
                          ["usefulness_mean", "Usefulness / 7"],
                          ["clarity_mean", "Clarity / 7"],
                          ["would_pay_yes", "Would pay: yes"],
                          ["would_pay_total", "Would pay: responses"],
                        ].map(([key, label]) => (
                          <tr key={key}>
                            <th>{label}</th>
                            <td>{data.terac.v1[key]}</td>
                            <td>{data.terac.v2[key]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    State: {data.terac.state}. No completed comparison is
                    available. No improvement is claimed.
                  </p>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
      <div className="live-footnote">
        <p>
          Growth is drafts only until separately authorized. This page does not
          enable sales, post feedback or start paid work.
        </p>
        <a className="text-link" href="/start">
          About starting an audit
        </a>
      </div>
    </>
  );
}
