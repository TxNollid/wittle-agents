// Shared by the browser page and the API: study definitions, deterministic per-participant
// ordering, and response validation.

export const STUDIES = {
  'anti-slop': { waves: ['v1', 'v2'], pairs: 5 },
  'local-guide': { waves: ['v1'] },
};

const ID = /^[A-Za-z0-9_-]{1,80}$/;

// FNV-1a → mulberry32, so the same participant always sees the same order.
function seedFrom(text) {
  let h = 0x811c9dc5;
  for (const c of text) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns [{ pair_id, rewrite_side: 'A'|'B' }] in display order.
export function antiSlopLayout(pairIds, participantKey) {
  const r = rng(seedFrom(participantKey));
  const order = [...pairIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((pair_id) => ({ pair_id, rewrite_side: r() < 0.5 ? 'A' : 'B' }));
}

const text = (v, max, required = false) => {
  if (v == null || v === '') { if (required) throw new Error('missing text'); return ''; }
  if (typeof v !== 'string') throw new Error('bad text');
  const s = v.trim();
  if (required && !s) throw new Error('missing text');
  if (s.length > max) throw new Error('text too long');
  return s;
};

// Validates a submitted response and returns the normalized row to store.
export function normalizeResponse(body, pairIdsByWave = {}) {
  if (!body || typeof body !== 'object') throw new Error('bad body');
  const study = body.study;
  if (!STUDIES[study]) throw new Error('unknown study');
  const wave = body.wave;
  if (!STUDIES[study].waves.includes(wave)) throw new Error('unknown wave');
  const submission_id = body.terac_submission_id;
  const task_id = body.terac_task_id;
  if (!ID.test(submission_id || '')) throw new Error('missing terac submission id');
  if (task_id != null && task_id !== '' && !ID.test(task_id)) throw new Error('bad task id');

  if (study === 'anti-slop') {
    const expected = antiSlopLayout(pairIdsByWave[wave] || [], `${submission_id}:${wave}`);
    if (!Array.isArray(body.answers) || body.answers.length !== expected.length) throw new Error('answer every pair');
    const answers = body.answers.map((a, i) => {
      const slot = expected[i];
      if (a?.pair_id !== slot.pair_id) throw new Error('pair order mismatch');
      if (!['A', 'B'].includes(a.choice)) throw new Error('pick A or B');
      return { pair_id: slot.pair_id, position: i + 1, rewrite_side: slot.rewrite_side, choice: a.choice,
        picked_rewrite: a.choice === slot.rewrite_side, why: text(a.why, 300) };
    });
    return { study, wave, submission_id, task_id: task_id || null,
      answers, note: text(body.note, 600, true) };
  }

  const wouldGo = Number(body.would_go);
  if (!Number.isInteger(wouldGo) || wouldGo < 1 || wouldGo > 7) throw new Error('would_go must be 1-7');
  return { study, wave, submission_id, task_id: task_id || null,
    answers: { would_go: wouldGo, problems: text(body.problems, 800, true), swap: text(body.swap, 300) }, note: '' };
}
