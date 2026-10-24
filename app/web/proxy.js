import { NextResponse } from "next/server";
import {
  entryCookie,
  entryEnabled,
  readEntryCookie,
  createEntryCookie,
} from "./lib/entry.mjs";
export function proxy(request) {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  if (
    entryEnabled() &&
    !readEntryCookie(request.cookies.get(entryCookie)?.value)
  ) {
    response.cookies.set(
      entryCookie,
      createEntryCookie(request.nextUrl.searchParams.get("ref")),
      {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: 86400,
      },
    );
  }
  return response;
}
export const config = { matcher: ["/start"] };
