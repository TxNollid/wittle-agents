import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEntryCookie,
  entryPrincipal,
  readEntryCookie,
  sanitizeRef,
  validateJoinResponse,
  adapterURL,
} from "../lib/entry.mjs";
process.env.WITTLE_ENTRY_COOKIE_SECRET =
  "fixture-only-cookie-key-not-a-real-secret-123456789";
const now = Date.parse("2026-10-24T17:30:00Z");
test("signed entry preserves id and sanitized attribution across retries, rejects tampering/expiry", () => {
  const cookie = createEntryCookie("lead_42", now),
    session = readEntryCookie(cookie, now);
  assert.equal(session.ref, "lead_42");
  assert.equal(
    readEntryCookie(cookie, now + 5000).request_id,
    session.request_id,
  );
  assert.equal(
    entryPrincipal(session),
    entryPrincipal(readEntryCookie(cookie, now + 5000)),
  );
  assert.notEqual(
    entryPrincipal(session),
    entryPrincipal(readEntryCookie(createEntryCookie("lead_42", now), now)),
  );
  assert.equal(readEntryCookie(cookie + "tamper", now), null);
  assert.equal(readEntryCookie(cookie, now + 86400000), null);
  assert.equal(sanitizeRef("external=true&buyer=external"), undefined);
});
test("redirect accepts only intended Rooms join URLs with matching mode and live expiry", () => {
  const valid = {
    room_id: "test_room",
    join_url: "https://rooms.wittlelabs.ai/join/test_token_123",
    expires_at: "2026-10-24T18:00:00Z",
    mode: "sandbox",
  };
  assert.equal(validateJoinResponse(valid, "sandbox", now), valid.join_url);
  for (const join_url of [
    "https://evil.test/join/test_token_123",
    "https://rooms.wittlelabs.ai.evil.test/join/test_token_123",
    "https://user:pass@rooms.wittlelabs.ai/join/test_token_123",
    "javascript:alert(1)",
    "http://rooms.wittlelabs.ai/join/test_token_123",
  ])
    assert.throws(() =>
      validateJoinResponse({ ...valid, join_url }, "sandbox", now),
    );
  const opaque = "https://rooms.wittlelabs.ai/invitation?token=test_token_123";
  assert.equal(
    validateJoinResponse({ ...valid, join_url: opaque }, "sandbox", now),
    opaque,
  );
  assert.throws(() => validateJoinResponse(valid, "live", now));
  assert.throws(() => validateJoinResponse(valid, "sandbox", now + 86400000));
});
test("adapter transport rejects downgrade and embedded credentials", () => {
  assert.equal(
    adapterURL("https://adapter.example/public/stats").protocol,
    "https:",
  );
  assert.throws(() => adapterURL("http://adapter.example/public/stats"));
  assert.throws(() => adapterURL("https://user:pass@adapter.example/stats"));
});
