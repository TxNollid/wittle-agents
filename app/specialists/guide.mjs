// Pre-delivery gate for Local Guide NYC itineraries.

export const GUIDE_VERSION = 'guide-check-v1';
export const LIMITS = { minStops: 4, maxStops: 7, maxCheckAgeHours: 24 };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t) => { const m = HHMM.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function publicHttpsUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.');
  } catch { return false; }
}

// plan: { date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM', budget_usd, stops: [
//   { name, address, arrive, depart, why, cost_usd, transit_min_from_prev, source_url, checked_at, hours } ] }
// hours is the observed opening hours string, or the literal 'unknown'.
export function checkItinerary(plan, { now = new Date() } = {}) {
  const reasons = [];
  const stops = Array.isArray(plan?.stops) ? plan.stops : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan?.date || '')) reasons.push('date must be YYYY-MM-DD');
  const start = toMin(plan?.start || ''), end = toMin(plan?.end || '');
  if (start === null || end === null || end <= start) reasons.push('start/end must be HH:MM with end after start');
  if (stops.length < LIMITS.minStops || stops.length > LIMITS.maxStops) {
    reasons.push(`needs ${LIMITS.minStops}-${LIMITS.maxStops} stops, got ${stops.length}`);
  }

  let prevDepart = start;
  let total = 0;
  const seen = new Set();
  stops.forEach((s, i) => {
    const at = `stop ${i + 1}${s?.name ? ` (${s.name})` : ''}`;
    for (const f of ['name', 'address', 'why']) {
      if (typeof s?.[f] !== 'string' || !s[f].trim()) reasons.push(`${at}: missing ${f}`);
    }
    if (!publicHttpsUrl(s?.source_url)) reasons.push(`${at}: needs an https source_url`);
    const checked = Date.parse(s?.checked_at);
    if (Number.isNaN(checked)) reasons.push(`${at}: missing checked_at`);
    else {
      const ageH = (now.getTime() - checked) / 3.6e6;
      if (ageH > LIMITS.maxCheckAgeHours) reasons.push(`${at}: checked ${Math.round(ageH)}h ago (max ${LIMITS.maxCheckAgeHours}h)`);
      if (ageH < -0.1) reasons.push(`${at}: checked_at is in the future`);
    }
    if (typeof s?.hours !== 'string' || !s.hours.trim()) reasons.push(`${at}: hours must be observed text or 'unknown'`);
    const a = toMin(s?.arrive || ''), d = toMin(s?.depart || '');
    if (a === null || d === null || d < a) reasons.push(`${at}: arrive/depart must be HH:MM, depart after arrive`);
    else {
      const transit = Number(s?.transit_min_from_prev ?? 0);
      if (!Number.isFinite(transit) || transit < 0) reasons.push(`${at}: bad transit_min_from_prev`);
      else if (prevDepart !== null && a < prevDepart + transit) reasons.push(`${at}: arrives before previous stop + transit`);
      if (end !== null && d > end) reasons.push(`${at}: runs past the end time`);
      prevDepart = d;
    }
    const cost = Number(s?.cost_usd);
    if (!Number.isFinite(cost) || cost < 0) reasons.push(`${at}: cost_usd must be a number ≥ 0`);
    else total += cost;
    const key = `${s?.name}|${s?.address}`.toLowerCase();
    if (seen.has(key)) reasons.push(`${at}: duplicate stop`);
    seen.add(key);
  });

  if (Number.isFinite(plan?.budget_usd) && total > plan.budget_usd) {
    reasons.push(`estimated cost $${total} exceeds budget $${plan.budget_usd}`);
  }
  return { ok: reasons.length === 0, version: GUIDE_VERSION, reasons, total_cost_usd: total, stops: stops.length };
}
