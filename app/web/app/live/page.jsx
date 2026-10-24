import { getStats } from "../../lib/stats.mjs";
import LiveDashboard from "./live-dashboard.jsx";
export const metadata = { title: "Activity & evidence" };
export const dynamic = "force-dynamic";
export default async function Live() {
  return (
    <main id="main" className="live-page">
      <div className="section-heading">
        <img
          className="heading-butterfly"
          src="/fieldglow/butterfly-dot-coral.svg"
          width="58"
          height="48"
          alt=""
          aria-hidden="true"
        />
        <h1>
          Activity, <em>with context.</em>
        </h1>
        <p>
          What happened, where it happened, and what we can actually verify. A
          referral is not proof of an external customer.
        </p>
      </div>
      <LiveDashboard initial={await getStats()} />
    </main>
  );
}
