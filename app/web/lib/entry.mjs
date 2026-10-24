import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
export const entryCookie = "wittle_entry";
export const webMode = () =>
  ["sandbox", "live"].includes(process.env.WITTLE_WEB_MODE)
    ? process.env.WITTLE_WEB_MODE
    : "fixture";
export const sanitizeRef = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
    ? value
    : undefined;
export function entryEnabled() {
  return (
    webMode() !== "fixture" &&
    process.env.WITTLE_ENTRY_ENABLED === "true" &&
    !!process.env.WITTLE_ENTRY_URL &&
    !!process.env.WITTLE_ENTRY_TOKEN &&
    (process.env.WITTLE_ENTRY_COOKIE_SECRET?.length ?? 0) >= 32
  );
}
export function adapterURL(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        loopback &&
        process.env.WITTLE_ALLOW_LOOPBACK_TEST_ADAPTERS === "true" &&
        !process.env.VERCEL
      ))
  )
    throw new Error("Invalid adapter URL");
  return url;
}
function signature(payload) {
  const secret = process.env.WITTLE_ENTRY_COOKIE_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Entry cookie secret missing");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
export function readEntryCookie(cookie, now = Date.now()) {
  try {
    if (typeof cookie !== "string" || cookie.length > 1024) return null;
    const [body, sig, extra] = cookie.split(".");
    if (extra || !body || !sig) return null;
    const expected = Buffer.from(signature(body)),
      provided = Buffer.from(sig);
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      return null;
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      !/^[a-f0-9-]{36}$/.test(value.request_id) ||
      !Number.isSafeInteger(value.expires_at) ||
      value.expires_at <= now ||
      value.expires_at > now + 86400000 ||
      (value.ref !== undefined && sanitizeRef(value.ref) !== value.ref)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function createEntryCookie(ref, now = Date.now()) {
  const body = Buffer.from(
    JSON.stringify({
      request_id: randomUUID(),
      expires_at: now + 86400000,
      ...(sanitizeRef(ref) ? { ref: sanitizeRef(ref) } : {}),
    }),
  ).toString("base64url");
  return `${body}.${signature(body)}`;
}
export function entryPrincipal(session) {
  return `entry_${signature(`principal:${session.request_id}`)}`;
}
export function validateJoinResponse(
  value,
  mode = webMode(),
  now = Date.now(),
) {
  const url = new URL(value.join_url);
  const origin = new URL(
    process.env.WITTLE_ROOMS_ORIGIN || "https://rooms.wittlelabs.ai",
  );
  if (
    origin.origin !== "https://rooms.wittlelabs.ai" ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    /[\s\\]/.test(value.join_url) ||
    value.join_url.length > 2000 ||
    typeof value.room_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(value.room_id) ||
    value.mode !== mode ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.expires_at) <= now
  )
    throw new Error("Invalid room entry response");
  return url.href;
}
