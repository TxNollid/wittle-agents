import { neon } from '@neondatabase/serverless';

export const queryOptions = () => ({ fetchOptions: { signal: AbortSignal.timeout(4500) } });

const schemas = [
  `CREATE TABLE IF NOT EXISTS review_orders (
    token text PRIMARY KEY,
    kind text NOT NULL,
    service_id text NOT NULL,
    order_ref text NOT NULL UNIQUE,
    material jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS review_responses (
    token text NOT NULL REFERENCES review_orders(token),
    submission_id text NOT NULL,
    task_id text,
    answers jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (token, submission_id)
  )`,
];

let db, ready;
export async function database() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('storage unavailable'), { status: 503 });
  db ||= neon(process.env.DATABASE_URL);
  ready ||= (async () => { for (const s of schemas) await db.query(s, [], queryOptions()); })()
    .catch((e) => { ready = undefined; throw e; });
  await ready;
  return db;
}

export const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export const json = (status, body) => Response.json(body, { status, headers });

export function isAdmin(request) {
  const token = process.env.STUDY_ADMIN_TOKEN;
  return Boolean(token) && request.headers.get('authorization') === `Bearer ${token}`;
}

export async function readJson(request, max = 32768) {
  const text = await request.text();
  if (text.length > max) throw Object.assign(new Error('too large'), { status: 413 });
  return JSON.parse(text);
}
