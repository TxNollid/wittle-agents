import ButterflyGarden from "./butterfly-garden.jsx";
export default function Home() {
  return (
    <main id="main">
      <section className="hero">
        <div className="hero-copy">
          <h1>
            A fresh pair of agents.
            <br />
            <span>A clearer website.</span>
          </h1>
          <p className="lede">
            Find what gets in your visitors’ way. Scope a focused website audit
            with our host and auditor in Wittle Rooms — before you pay anything.
          </p>
          <div className="actions">
            <a className="button" href="/start">
              Get an audit <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="#sample">
              See what you’ll receive
            </a>
          </div>
          <p className="subtle">
            Free scoping · $19 working price · No subscription
          </p>
        </div>
        <ButterflyGarden />
      </section>
      <section className="scope-strip" aria-label="Audit scope">
        <div>
          <strong>Up to 5</strong>
          <span>public pages</span>
        </div>
        <div>
          <strong>Desktop + mobile</strong>
          <span>both perspectives</span>
        </div>
        <div>
          <strong>Up to 10</strong>
          <span>prioritized findings</span>
        </div>
        <div>
          <strong>1 revision</strong>
          <span>within the agreed scope</span>
        </div>
      </section>
      <section className="journey">
        <div>
          <h2>
            Agree first.
            <br />
            Pay only if it fits.
          </h2>
          <p>
            You bring the URL and the goal. The agents help turn them into a
            bounded brief. No pressure to buy unfinished scoping.
          </p>
        </div>
        <ol>
          <li>
            <h3>Meet in your private room</h3>
            <p>
              Our host asks about your site, what you want to improve, and which
              pages matter. The auditor checks what’s feasible.
            </p>
          </li>
          <li>
            <h3>Review the scope and quote</h3>
            <p>
              You see the agreed pages, deliverables and exact price. The
              working offer is $19 one-time. Nothing charges automatically.
            </p>
          </li>
          <li>
            <h3>Pay on Whop. Receive it in the room.</h3>
            <p>
              After verified payment, the auditor works from the frozen scope
              and delivers the report in the same room. One in-scope revision is
              included.
            </p>
          </li>
        </ol>
      </section>
      <section id="sample" className="sample-section">
        <div className="section-heading">
          <h2>Useful feedback has receipts.</h2>
          <p>
            Here’s the structure of a finding. This is an illustrative example,
            not a customer audit or a claim about your website.
          </p>
        </div>
        <article className="sample-report">
          <div className="sample-meta">
            <span className="badge">Illustrative sample</span>
            <span>Homepage · Mobile · Clarity</span>
          </div>
          <h3>Explain the commitment before the button.</h3>
          <dl>
            <div>
              <dt>Observation</dt>
              <dd>
                A visitor sees a “Get started” action without knowing whether
                the next step asks for a call, an account, or a payment.
              </dd>
            </div>
            <div>
              <dt>Evidence to capture</dt>
              <dd>
                The exact button label, surrounding copy, viewport and page
                location. A real audit must verify these on the agreed public
                page.
              </dd>
            </div>
            <div>
              <dt>Recommendation</dt>
              <dd>
                Name the next step and its commitment. If the action opens a
                short demo booking, say so. Match the label to the actual
                destination.
              </dd>
            </div>
            <div>
              <dt>How to check</dt>
              <dd>
                Ask a new visitor what they expect to happen before clicking.
                Compare their answer with the actual next screen.
              </dd>
            </div>
          </dl>
        </article>
        <p className="scope-note">
          No invented defects, guaranteed uplift, or changes to your site.
          Findings may be fewer than ten when the evidence supports fewer.
        </p>
      </section>
      <section className="closing">
        <h2>
          Start with a conversation,
          <br />
          not a checkout.
        </h2>
        <div>
          <a className="button" href="/start">
            Scope my audit for free <span aria-hidden="true">↗</span>
          </a>
          <p>
            No custom account here. The conversation happens in Wittle Rooms.
          </p>
        </div>
      </section>
    </main>
  );
}
