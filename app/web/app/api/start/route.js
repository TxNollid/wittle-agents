import { NextResponse } from "next/server";
import {
  entryCookie,
  entryPrincipal,
  entryEnabled,
  readEntryCookie,
  validateJoinResponse,
  adapterURL,
  webMode,
} from "../../../lib/entry.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function back(request, state) {
  const url = new URL("/start", request.headers.get("origin"));
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export async function POST(request) {
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    const parsed = new URL(origin);
    sameOrigin = ["https:", "http:"].includes(parsed.protocol) &&
      parsed.origin === origin && parsed.host === request.headers.get("host");
  } catch {}
  if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site")
    return new Response("Request not allowed", { status: 403 });
  if (webMode() === "fixture") return back(request, "fixture");
  if (!entryEnabled()) return back(request, "unavailable");
  const session = readEntryCookie(request.cookies.get(entryCookie)?.value);
  if (!session) return back(request, "session_expired");
  try {
    const response = await fetch(adapterURL(process.env.WITTLE_ENTRY_URL), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        "Content-Type": "application/json",
        "X-Wittle-Entry-Principal": entryPrincipal(session),
        ...(process.env.WITTLE_ENTRY_TOKEN
          ? { Authorization: `Bearer ${process.env.WITTLE_ENTRY_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        request_id: session.request_id,
        ...(session.ref ? { ref: session.ref } : {}),
      }),
    });
    if (response.status === 202) return back(request, "pending");
    if ([409, 429, 503].includes(response.status))
      return back(request, "unavailable");
    if (!response.ok) return back(request, "failed");
    const value = await response.json();
    const joinURL = validateJoinResponse(value);
    const result = NextResponse.redirect(joinURL, 303);
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  } catch {
    return back(request, "failed");
  }
}
