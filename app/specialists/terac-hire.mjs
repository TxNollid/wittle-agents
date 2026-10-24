// Per-hire Terac: turn one paid order's deliverable into a review task and a Terac draft request.
// Launching the draft spends Terac credit; only do it for a paid order whose buyer chose the human check.

import { getSpecialist } from './catalog.mjs';

export const STUDIES_ORIGIN = 'https://wittle-terac-studies.vercel.app';

// Material shown to Terac reviewers. Never include buyer name, email, room or payment identifiers.
export function reviewMaterial(service_id, deliverable) {
  if (service_id === 'anti_slop_v1') {
    if (typeof deliverable?.rewrite !== 'string' || !deliverable.rewrite.trim()) throw new Error('rewrite required');
    return { kind: 'human_read', material: { heading: `Text written for ${deliverable.destination || 'the web'}`,
      sections: [{ title: 'The text', body: deliverable.rewrite }] } };
  }
  if (service_id === 'local_guide_nyc_v1') {
    const p = deliverable?.plan;
    if (!Array.isArray(p?.stops) || !p.stops.length) throw new Error('plan required');
    return { kind: 'local_check', material: { heading: `${p.date}, ${p.start}–${p.end}`,
      sections: p.stops.map((s) => ({ title: `${s.arrive}–${s.depart} · ${s.name}`,
        body: `${s.address}\n${s.why}\nAbout $${s.cost_usd} · ${s.transit_min_from_prev} min from previous stop · Hours: ${s.hours}\nSource: ${s.source_url}` })) } };
  }
  if (service_id === 'website_audit_v1') {
    const findings = deliverable?.findings;
    if (!Array.isArray(findings)) throw new Error('findings required');
    return { kind: 'founder_review', material: { heading: `Website audit of ${deliverable.site_url}`,
      sections: findings.slice(0, 10).map((f, i) => ({ title: `${i + 1}. ${f.title || f.rule || 'Finding'}`,
        body: [f.observation, f.impact && `Impact: ${f.impact}`, f.fix && `Fix: ${f.fix}`, f.url && `Page: ${f.url}`].filter(Boolean).join('\n') })) } };
  }
  throw new Error(`no human check for ${service_id}`);
}

// Body for POST {STUDIES_ORIGIN}/api/review (admin bearer). order_ref must be the paid order ID.
export function reviewOrderRequest(service_id, order_ref, deliverable) {
  return { service_id, order_ref, ...reviewMaterial(service_id, deliverable) };
}

// Fields for terac_create_opportunity. The provider's exact parameter names are mapped by the
// Terac operator; this is the content and audience we ask for.
export function teracDraft(service_id, task_url) {
  const s = getSpecialist(service_id);
  const check = s.human_check;
  if (!check) throw new Error(`${service_id} has no human check`);
  if (!task_url?.startsWith(`${STUDIES_ORIGIN}/review?order=`)) throw new Error('task_url must be a review page');
  return {
    title: check.terac_title,
    description: check.terac_description,
    audience: check.audience,
    participants: check.participants,
    minutes: check.minutes,
    task_type: 'external_link',
    task_url,
    review_mode: 'manual_review',
  };
}

// Launch gate: paid, buyer chose the check, check enabled, cost within the cap and price margin.
export function mayLaunch({ service_id, order_paid, buyer_opted_in, priced_total_minor }) {
  const check = getSpecialist(service_id).human_check;
  if (!check?.enabled) return { ok: false, reason: 'human check not enabled for sale' };
  if (!order_paid) return { ok: false, reason: 'order not paid' };
  if (!buyer_opted_in) return { ok: false, reason: 'buyer did not choose a human check' };
  if (!Number.isInteger(priced_total_minor) || priced_total_minor <= 0) return { ok: false, reason: 'no Terac price' };
  if (priced_total_minor > check.max_terac_cost_minor) return { ok: false, reason: 'Terac price above cap' };
  return { ok: true };
}
