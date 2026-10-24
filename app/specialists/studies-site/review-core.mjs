// Per-hire human review: one Terac task per paid order. Shared by the page and the API.

export const REVIEW_KINDS = {
  human_read: {
    title: 'Does this sound like a real person wrote it?',
    intro: 'Someone hired an AI editor to make their text sound natural. Read the edited text and tell us honestly how it reads. About 3 minutes.',
    questions: [
      { id: 'human_score', type: 'scale', label: 'How much does this sound like a real person wrote it? 1 = obviously AI, 7 = clearly a person', required: true },
      { id: 'ai_lines', type: 'text', label: 'Copy any phrase or sentence that still sounds AI-written. Write "none" if none.', max: 600, required: true },
      { id: 'suggestion', type: 'text', label: 'One change that would make it sound more natural (optional)', max: 300 },
    ],
  },
  local_check: {
    title: 'Would you do this day in New York?',
    intro: 'Someone hired an AI agent to plan a day in New York City. As a New Yorker, check the plan. About 5 minutes.',
    questions: [
      { id: 'would_go', type: 'scale', label: 'If a friend sent you this plan, would you go? 1 = no way, 7 = definitely', required: true },
      { id: 'problems', type: 'text', label: 'Is anything wrong, closed, outdated or a bad idea? Write "nothing" if not.', max: 800, required: true },
      { id: 'swap', type: 'text', label: 'Which one stop would you swap, and for what? (optional)', max: 300 },
    ],
  },
  founder_review: {
    title: 'Founder take on a website audit',
    intro: 'A small business hired an AI agent to audit their website. Read the audit and give your take as a founder. About 10 minutes.',
    questions: [
      { id: 'biggest_risk', type: 'text', label: 'The single biggest risk on this site for the business', max: 600, required: true },
      { id: 'first_fix', type: 'text', label: 'One specific fix you would do first', max: 600, required: true },
      { id: 'disagree', type: 'text', label: 'Anything in the audit you disagree with? Write "nothing" if not.', max: 600, required: true },
    ],
  },
};

const TOKEN = /^[a-f0-9]{32}$/;
const SUBMISSION = /^[A-Za-z0-9_-]{1,80}$/;

export function isToken(v) { return typeof v === 'string' && TOKEN.test(v); }

// Order material: what reviewers see. No buyer identity, room IDs or payment data.
export function normalizeOrder(body) {
  if (!body || typeof body !== 'object') throw new Error('bad body');
  const kind = body.kind;
  if (!REVIEW_KINDS[kind]) throw new Error('unknown kind');
  if (typeof body.service_id !== 'string' || !/^[a-z0-9_]{1,40}$/.test(body.service_id)) throw new Error('bad service_id');
  if (typeof body.order_ref !== 'string' || !SUBMISSION.test(body.order_ref)) throw new Error('bad order_ref');
  const m = body.material;
  if (!m || typeof m.heading !== 'string' || !Array.isArray(m.sections) || !m.sections.length || m.sections.length > 20) throw new Error('bad material');
  const sections = m.sections.map((s) => {
    if (typeof s?.title !== 'string' || typeof s?.body !== 'string') throw new Error('bad section');
    if (s.title.length > 120 || s.body.length > 6000) throw new Error('section too long');
    return { title: s.title, body: s.body };
  });
  if (JSON.stringify(sections).length > 20000) throw new Error('material too long');
  return { kind, service_id: body.service_id, order_ref: body.order_ref, material: { heading: m.heading.slice(0, 160), sections } };
}

export function normalizeReview(body, kind) {
  if (!body || typeof body !== 'object') throw new Error('bad body');
  if (!isToken(body.order)) throw new Error('bad order');
  if (!SUBMISSION.test(body.terac_submission_id || '')) throw new Error('missing terac submission id');
  const taskId = body.terac_task_id;
  if (taskId != null && taskId !== '' && !SUBMISSION.test(taskId)) throw new Error('bad task id');
  const def = REVIEW_KINDS[kind];
  if (!def) throw new Error('unknown kind');
  const answers = {};
  for (const q of def.questions) {
    const v = body.answers?.[q.id];
    if (q.type === 'scale') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 7) throw new Error(`${q.id} must be 1-7`);
      answers[q.id] = n;
    } else {
      const s = typeof v === 'string' ? v.trim() : '';
      if (q.required && !s) throw new Error(`${q.id} is required`);
      if (s.length > q.max) throw new Error(`${q.id} too long`);
      answers[q.id] = s;
    }
  }
  return { order: body.order, submission_id: body.terac_submission_id, task_id: taskId || null, answers };
}
