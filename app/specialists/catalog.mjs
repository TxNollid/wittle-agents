// Specialist definitions. One entry per sellable agent; the runtime, host prompt,
// quote scope and Terac study config are all derived from these.

export const MAKER = 'Wittle Labs, an AI lab based in NYC';

export const SPECIALISTS = [
  {
    service_id: 'anti_slop_v1',
    agent_name: 'anti-slop-editor',
    rooms_agent_id: 'agt_C9kVbknuDL6OXz_cOk7Fmg', // HostedAgents account (user_01M5QVPNW92H8MXV4MXFV6HKRB)
    title: 'Anti-Slop Editor',
    tagline: 'Make your draft sound like you wrote it.',
    maker: MAKER,
    prompt: 'prompts/anti-slop-editor-v1.md',
    prompt_version: 'anti-slop-editor-v1',
    checker: 'slop.mjs#checkRewrite',
    tools: [],
    offer: { amount_minor: 900, currency: 'usd', delivery_minutes: 5, revisions: 1 },
    inputs: {
      draft: { type: 'text', required: true, max_words: 600 },
      destination: { type: 'enum', required: true, values: ['linkedin', 'x', 'landing_page', 'cold_email', 'bio', 'other'] },
      voice_samples: { type: 'text[]', required: false, max_items: 2, max_words_each: 300 },
    },
    deliverables: [
      'Rewrite of the draft that keeps every fact, number, link and name',
      'Up to 8 notes on what changed and why',
      'Before/after slop score (slop-v1)',
    ],
    acceptance_checks: [
      'Rewrite slop score ≤ 2.0 and lower than the original',
      'Every number, URL, email, @handle and quoted string from the draft is present',
      'Rewrite no more than 25% longer than the draft',
    ],
    exclusions: ['Writing in someone else\'s name or voice without permission', 'New claims or statistics', 'Publishing for the buyer'],
    scoping: 'Ask for the draft, where it will be published and (optionally) one or two samples of how the buyer normally writes. Confirm the draft is the buyer\'s own and under 600 words.',
    human_check: {
      enabled: false, kind: 'human_read', audience: 'US adults, English', participants: 3, minutes: 3,
      max_terac_cost_minor: 450,
      terac_title: 'Does this text sound like a real person wrote it?',
      terac_description: 'Read one short text (a post, email or bio) and rate how natural it sounds, then point out any line that still sounds AI-written. About 3 minutes.',
    },
    terac: {
      study: 'anti-slop-blind-test',
      audience: 'US general population, English',
      participants: 10,
      minutes: 5,
      metric: '% of pairs where the rewrite is picked as human-written',
    },
  },
  {
    service_id: 'local_guide_nyc_v1',
    agent_name: 'local-guide-nyc',
    rooms_agent_id: 'agt_ZhRtbhHsTpc_WOIVlxglvw', // HostedAgents account (user_01M5QVPNW92H8MXV4MXFV6HKRB)
    title: 'Local Guide NYC',
    tagline: 'A real, checked plan for your day in New York.',
    maker: MAKER,
    prompt: 'prompts/local-guide-nyc-v1.md',
    prompt_version: 'local-guide-nyc-v1',
    checker: 'guide.mjs#checkItinerary',
    tools: ['exa.web_search_exa', 'exa.web_fetch_exa'],
    offer: { amount_minor: 1500, currency: 'usd', delivery_minutes: 20, revisions: 1 },
    inputs: {
      date: { type: 'date', required: true },
      start: { type: 'time', required: true },
      end: { type: 'time', required: true },
      start_area: { type: 'text', required: true },
      budget_usd: { type: 'number', required: true },
      interests: { type: 'text', required: true },
      group: { type: 'text', required: false },
      access_needs: { type: 'text', required: false },
    },
    deliverables: [
      'Timed plan of 4–7 stops in NYC',
      'For each stop: address, why it fits, cost estimate, transit time from the previous stop, observed hours',
      'Source link and check time for every stop',
    ],
    acceptance_checks: [
      'Every stop has a source URL checked within 24 h of delivery',
      'Hours are observed or labeled unknown, never guessed',
      'Schedule fits the window including transit; total cost within budget',
    ],
    exclusions: ['Bookings, tickets or purchases', 'Places outside the five boroughs', 'Guaranteed availability'],
    scoping: 'Ask for date, start/end time, starting neighborhood, budget per person, interests, group and access needs. Confirm the date is within the next 14 days.',
    human_check: {
      enabled: false, kind: 'local_check', audience: 'New York City residents', participants: 2, minutes: 5,
      max_terac_cost_minor: 750,
      terac_title: 'Would you do this day in New York?',
      terac_description: 'Check a one-day New York City plan made by an AI agent: would you go, and is anything wrong, closed or outdated? About 5 minutes.',
    },
    terac: {
      study: 'local-guide-nyc-rating',
      audience: 'New York City residents',
      participants: 5,
      minutes: 5,
      metric: 'mean "would you go" (1–7) and count of reported errors',
    },
  },
  {
    service_id: 'website_audit_v1',
    agent_name: 'website-auditor',
    rooms_agent_id: 'agt_Y4aZDcQgPEYtj4A9OOMuiA', // HostedAgents account (user_01M5QVPNW92H8MXV4MXFV6HKRB)
    title: 'Website Auditor',
    tagline: 'Up to 10 evidence-backed fixes for your site, desktop and mobile.',
    maker: MAKER,
    prompt: '../auditor/prompts/auditor-v1.md',
    prompt_version: 'auditor-v1',
    checker: '../auditor/audit.mjs#runAudit',
    tools: ['auditor.browser'],
    offer: { amount_minor: 1900, currency: 'usd', delivery_minutes: 10, revisions: 1 },
    inputs: null, // wa-v2.1 Scope, unchanged
    deliverables: ['Audit of up to 5 public pages, desktop and mobile, up to 10 prioritized findings with evidence'],
    acceptance_checks: ['See app/auditor/README.md'],
    exclusions: ['Site changes', 'Conversion guarantees'],
    scoping: 'Unchanged: app/host-prompts/free-specialist.md.',
    addons: [
      {
        addon_id: 'founder_review_v1',
        // Off until a real Terac task → submission → approval round trip is proven. Terac's
        // minimum recruitment window is 5 days with no verified turnaround, so no deadline is sold yet.
        enabled: false,
        title: 'Verified founder review',
        description: 'A verified startup founder reads your audit and writes their take: the biggest risk and one fix.',
        amount_minor: 2900,
        currency: 'usd',
        deadline_hours: 48,
        refund: 'Full refund of the add-on if no verified founder review is delivered within 48 hours.',
        state_machine: 'founder-review.mjs',
      },
    ],
    human_check: {
      enabled: false, kind: 'founder_review', audience: 'Verified startup founders/operators', participants: 1, minutes: 10,
      max_terac_cost_minor: 1450,
      terac_title: 'Founder take on a website audit',
      terac_description: 'Read an AI-written website audit for a small business and write your founder take: the biggest risk, one fix to do first, and anything you disagree with. About 10 minutes.',
    },
    terac: {
      study: 'auditor-founder-review',
      audience: 'Verified startup founders/operators',
      participants: 3,
      minutes: 10,
      metric: 'standing opportunity for founder review add-on orders',
    },
  },
];

export const LIVE_ON_RAILS = new Set(['website_audit_v1']); // others join after the Auditor's live gate

export function getSpecialist(service_id) {
  const s = SPECIALISTS.find((x) => x.service_id === service_id);
  if (!s) throw new Error(`unknown service_id ${service_id}`);
  return s;
}

export function profileCard(service_id) {
  const s = getSpecialist(service_id);
  const price = `$${(s.offer.amount_minor / 100).toFixed(0)}`;
  const lines = [`${s.title} — ${s.tagline}`, `Built by ${s.maker}.`, `${price}, ~${s.offer.delivery_minutes} min, ${s.offer.revisions} revision.`];
  for (const a of (s.addons || []).filter((x) => x.enabled)) lines.push(`Add-on: ${a.title}, $${(a.amount_minor / 100).toFixed(0)}. ${a.refund}`);
  return lines.join('\n');
}

export function validateCatalog(list = SPECIALISTS) {
  const errors = [];
  const ids = new Set();
  for (const s of list) {
    const at = s.service_id || '(missing id)';
    if (ids.has(s.service_id)) errors.push(`${at}: duplicate service_id`);
    ids.add(s.service_id);
    if (!/^[a-z0-9-]{1,24}$/.test(s.agent_name || '')) errors.push(`${at}: agent_name must fit Rooms naming (≤24, lowercase)`);
    if (!Number.isInteger(s.offer?.amount_minor) || s.offer.amount_minor <= 0) errors.push(`${at}: bad price`);
    if (s.offer?.currency !== 'usd') errors.push(`${at}: currency must be usd`);
    if (s.offer?.revisions !== 1) errors.push(`${at}: exactly one revision`);
    for (const f of ['deliverables', 'acceptance_checks', 'exclusions']) {
      if (!Array.isArray(s[f]) || !s[f].length) errors.push(`${at}: ${f} required`);
    }
    if (!s.terac?.study || !(s.terac?.participants > 0)) errors.push(`${at}: terac study required`);
    if (s.maker !== MAKER) errors.push(`${at}: maker must be "${MAKER}"`);
    for (const a of s.addons || []) {
      if (!a.refund || !(a.deadline_hours > 0)) errors.push(`${at}/${a.addon_id}: add-on needs deadline and refund terms`);
    }
  }
  return errors;
}
