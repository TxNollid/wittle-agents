import { neon } from '@neondatabase/serverless';
import { normalizeResponse } from '../study-core.mjs';
import pairsV1 from '../data/anti-slop-v1.json' with { type: 'json' };
import pairsV2 from '../data/anti-slop-v2.json' with { type: 'json' };

const maxBody = 16384;
const pairIdsByWave = { v1: pairsV1.pairs.map((p) => p.id), v2: pairsV2.pairs.map((p) => p.id) };
const queryOptions = () => ({ fetchOptions: { signal: AbortSignal.timeout(4500) } });
const schema = `CREATE TABLE IF NOT EXISTS study_responses (
  study text NOT NULL,
  wave text NOT NULL,
  submission_id text NOT NULL,
  task_id text,
  answers jsonb NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (study, submission_id)
)`;

let db, schemaReady;
async function ready() {
  db ||= neon(process.env.DATABASE_URL);
  schemaReady ||= db.query(schema, [], queryOptions()).catch((e) => { schemaReady = undefined; throw e; });
  await schemaReady;
  return db;
}

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, body) => Response.json(body, { status, headers });

async function readBody(request) {
  const text = await request.text();
  if (text.length > maxBody) throw Object.assign(new Error('too large'), { status: 413 });
  return JSON.parse(text);
}

async function results(request) {
  const token = process.env.STUDY_ADMIN_TOKEN;
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) return json(401, { error: 'unauthorized' });
  const database = await ready();
  const rows = await database.query(
    'SELECT study, wave, submission_id, task_id, answers, note, created_at FROM study_responses ORDER BY created_at',
    [], queryOptions());
  return json(200, { rows });
}

export default {
  async fetch(request) {
    if (request.method === 'GET') return results(request);
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (request.headers.get('origin') !== new URL(request.url).origin) return json(403, { error: 'forbidden' });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json(415, { error: 'json only' });
    let row;
    try {
      row = normalizeResponse(await readBody(request), pairIdsByWave);
      if (row.study === 'anti-slop' && row.wave === 'v2' && pairsV2.ready !== true) return json(409, { saved: false, error: 'wave v2 is not open' });
    } catch (error) {
      return json(error.status === 413 ? 413 : 400, { saved: false, error: error.message });
    }
    if (!process.env.DATABASE_URL) return json(503, { saved: false, error: 'storage unavailable' });
    try {
      const database = await ready();
      // One response per Terac submission per study; a retry keeps the first answer.
      await database.query(
        `INSERT INTO study_responses (study, wave, submission_id, task_id, answers, note)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (study, submission_id) DO NOTHING`,
        [row.study, row.wave, row.submission_id, row.task_id, JSON.stringify(row.answers), row.note], queryOptions());
      return json(200, { saved: true, confirmation: `${row.study}-${row.submission_id}`.slice(0, 96) });
    } catch {
      return json(503, { saved: false, error: 'storage unavailable' });
    }
  },
};
