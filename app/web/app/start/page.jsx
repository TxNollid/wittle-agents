import { entryEnabled, webMode } from "../../lib/entry.mjs";
import StartButton from "./start-button.jsx";
export const metadata = { title: "Start your audit" };
export const dynamic = "force-dynamic";
const messages = {
  fixture: [
    "This is a fixture walkthrough.",
    "No room was created and no payment was requested. Real entry will open here after the provider and sandbox checks pass.",
  ],
  pending: [
    "Your room is being prepared.",
    "Try again shortly. We keep the same entry request so a retry does not ask for a second room.",
  ],
  unavailable: [
    "Room entry is unavailable.",
    "The service is not ready to welcome a buyer. Please try again later; nothing has been charged.",
  ],
  failed: [
    "We couldn’t open your room.",
    "The room service did not return a usable response. Retry uses the same entry request. Nothing has been charged here.",
  ],
  session_expired: [
    "Your entry session expired.",
    "This page has prepared a new entry session. Try the button again.",
  ],
};
export default async function Start({ searchParams }) {
  const params = await searchParams;
  const mode = webMode(),
    enabled = entryEnabled();
  const state = Object.hasOwn(messages, params.state) ? params.state : null;
  return (
    <main id="main" className="start-page">
      <a className="text-link" href="/">
        ← Back to the offer
      </a>
      <div className="start-grid">
        <section>
          <img
            className="heading-butterfly"
            src="/fieldglow/butterfly-line-cobalt.svg"
            width="58"
            height="48"
            alt=""
            aria-hidden="true"
          />
          <h1>
            Let’s scope
            <br />
            <span>your audit.</span>
          </h1>
          <p className="lede">
            You’ll meet the host and auditor in one private Wittle Room. Bring
            your website URL and one thing you want to improve.
          </p>
          <ol className="start-checklist">
            <li>Choose up to five public pages.</li>
            <li>Agree what the audit will cover, for free.</li>
            <li>Review the exact quote before deciding to pay.</li>
          </ol>
          <p>
            No card details here. Payment, if you choose it, happens on Whop
            after the scope is agreed.
          </p>
        </section>
        <section className="entry-panel" aria-label="Open your private room">
          <span className="badge">
            {mode === "fixture"
              ? "Fixture mode · no real room"
              : mode === "sandbox"
                ? "Sandbox · test entry"
                : "Live provider mode"}
          </span>
          <h2>Your brief starts here.</h2>
          <p>
            One buyer per room. Your private link is not published on this site
            or sent to analytics.
          </p>
          {state && (
            <div className="notice" role="status">
              <h3>{messages[state][0]}</h3>
              <p>{messages[state][1]}</p>
            </div>
          )}
          {!enabled && mode !== "fixture" && !state && (
            <div className="notice" role="status">
              <h3>Entry is not open yet.</h3>
              <p>
                Provider readiness and release checks must pass first. No room
                or payment will be created.
              </p>
            </div>
          )}
          <form action="/api/start" method="post">
            <StartButton
              disabled={mode !== "fixture" && !enabled}
              fixture={mode === "fixture"}
            />
          </form>
          <p className="subtle">
            {mode === "fixture"
              ? "This preview never allocates a buyer room."
              : "The button requests your room. Viewing this page does not."}
          </p>
          <a className="text-link" href="/live">
            Check service evidence
          </a>
        </section>
      </div>
    </main>
  );
}
