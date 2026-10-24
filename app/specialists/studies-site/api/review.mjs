// Per-hire review tasks.
// POST  (admin)   create an order's review material → { token, task_url }
// GET   ?order=   public material for the review page (no buyer data)
// GET   ?order=&responses=1 (admin) read the submissions for that order
// PUT   (page)    save one Terac participant's answers
import { randomBytes } from 'node:crypto';
import { database, json, isAdmin, readJson, queryOptions } from '../lib/db.mjs';
import { normalizeOrder, normalizeReview, isToken, REVIEW_KINDS } from '../review-core.mjs';

async function createOrder(request) {
  if (!isAdmin(request)) return json(401, { error: 'unauthorized' });
  const order = normalizeOrder(await readJson(request));
  const db = await database();
  const token = randomBytes(16).toString('hex');
  // order_ref is unique: a retry for the same paid order returns the existing task.
  const rows = await db.query(
    `INSERT INTO review_orders (token, kind, service_id, order_ref, material) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (order_ref) DO UPDATE SET order_ref = EXCLUDED.order_ref RETURNING token, kind`,
    [token, order.kind, order.service_id, order.order_ref, JSON.stringify(order.material)], queryOptions());
  const origin = new URL(request.url).origin;
  return json(200, { token: rows[0].token, kind: rows[0].kind,
    task_url: `${origin}/review?order=${rows[0].token}&teracSubmissionId={submissionId}&taskId={taskId}` });
}

async function readOrder(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('order');
  if (!isToken(token)) return json(400, { error: 'bad order' });
  const db = await database();
  if (url.searchParams.get('responses')) {
    if (!isAdmin(request)) return json(401, { error: 'unauthorized' });
    const rows = await db.query('SELECT submission_id, task_id, answers, created_at FROM review_responses WHERE token = $1 ORDER BY created_at', [token], queryOptions());
    return json(200, { rows });
  }
  const rows = await db.query('SELECT kind, material FROM review_orders WHERE token = $1', [token], queryOptions());
  if (!rows.length) return json(404, { error: 'not found' });
  const def = REVIEW_KINDS[rows[0].kind];
  return json(200, { kind: rows[0].kind, title: def.title, intro: def.intro, questions: def.questions, material: rows[0].material });
}

async function saveReview(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return json(403, { error: 'forbidden' });
  const body = await readJson(request);
  if (!isToken(body?.order)) return json(400, { saved: false, error: 'bad order' });
  const db = await database();
  const found = await db.query('SELECT kind FROM review_orders WHERE token = $1', [body.order], queryOptions());
  if (!found.length) return json(404, { saved: false, error: 'not found' });
  const row = normalizeReview(body, found[0].kind);
  await db.query(
    `INSERT INTO review_responses (token, submission_id, task_id, answers) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (token, submission_id) DO NOTHING`,
    [row.order, row.submission_id, row.task_id, JSON.stringify(row.answers)], queryOptions());
  return json(200, { saved: true, confirmation: `review-${row.submission_id}`.slice(0, 96) });
}

export default {
  async fetch(request) {
    try {
      if (request.method === 'POST') return await createOrder(request);
      if (request.method === 'GET') return await readOrder(request);
      if (request.method === 'PUT') return await saveReview(request);
      return json(405, { error: 'method not allowed' });
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError || /bad|missing|unknown|required|must|long/.test(error.message) ? 400 : 503);
      return json(status, { saved: false, error: status === 503 ? 'storage unavailable' : error.message });
    }
  },
};
