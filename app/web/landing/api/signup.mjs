import { neon } from "@neondatabase/serverless";
import { normalizeSignup, campaignKeys } from "../signup-fields.mjs";

const maxBody = 4096;
let database, schemaReady;
const queryOptions = () => ({ fetchOptions: { signal: AbortSignal.timeout(4500) } });
const schema = `CREATE TABLE IF NOT EXISTS wittle_agents_waitlist (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  utm jsonb NOT NULL,
  consent_version text NOT NULL
)`;

async function saveSignup(signup) {
  database ||= neon(process.env.DATABASE_URL);
  schemaReady ||= database.query(schema, [], queryOptions()).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  await schemaReady;
  // Unique canonical email is the atomic dedupe boundary. Keep original consent/UTMs.
  await database.query(
    "INSERT INTO wittle_agents_waitlist (email, utm, consent_version) VALUES ($1, $2::jsonb, $3) ON CONFLICT (email) DO NOTHING",
    [signup.email, JSON.stringify(signup.utm), "early-access-v1"],
    queryOptions(),
  );
}

async function readBody(request) {
  if (Number(request.headers.get("content-length")) > maxBody)
    throw Object.assign(new Error("BODY_TOO_LARGE"), { status: 413 });
  if (!request.body) throw new Error("EMPTY_BODY");
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBody) {
      await reader.cancel();
      throw Object.assign(new Error("BODY_TOO_LARGE"), { status: 413 });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function reply(request, status, saved, code) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (request.headers.get("accept")?.includes("text/html")) {
    const message = saved ? "You’re on the list." : status === 400 ? "Please enter a valid email address." : "We couldn’t save your email.";
    const detail = saved ? "We’ll be in touch with early-access updates." : "Nothing has been confirmed. Please go back and try again.";
    headers["Content-Type"] = "text/html; charset=utf-8";
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Early access — Wittle Agents</title><link rel="stylesheet" href="/landing.css"></head><body><main class="process-main"><p class="eyebrow">Wittle Agents · Early access</p><h1>${message}</h1><p class="lede">${detail}</p><a href="/">Back to Wittle Agents</a></main></body></html>`, { status, headers });
  }
  return Response.json(saved ? { saved: true } : { saved: false, code }, { status, headers });
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      const response = reply(request, 405, false, "METHOD_NOT_ALLOWED");
      response.headers.set("Allow", "POST");
      return response;
    }
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return reply(request, 403, false, "FORBIDDEN");
    const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!["application/json", "application/x-www-form-urlencoded"].includes(type))
      return reply(request, 415, false, "UNSUPPORTED_CONTENT_TYPE");
    let signup;
    try {
      const body = await readBody(request);
      let input;
      if (type === "application/json") input = JSON.parse(body);
      else {
        const fields = new URLSearchParams(body);
        input = { email: fields.get("email"), utm: Object.fromEntries(campaignKeys.map((key) => [key, fields.get(key)])) };
      }
      signup = normalizeSignup(input);
    } catch (error) {
      return reply(request, error.status === 413 ? 413 : 400, false, error.status === 413 ? "BODY_TOO_LARGE" : "INVALID_SIGNUP");
    }
    if (!process.env.DATABASE_URL) return reply(request, 503, false, "SIGNUP_UNAVAILABLE");
    try {
      await saveSignup(signup);
      // Identical response for new/existing addresses; never expose list membership.
      return reply(request, 200, true);
    } catch {
      return reply(request, 503, false, "SIGNUP_UNAVAILABLE");
    }
  },
};
