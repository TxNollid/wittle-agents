import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createEntryServer } from "../rooms-entry/server.mjs";

const fail = (code, status) => Object.assign(new Error(code), { code, status });
const hash = (value) => createHash("sha256").update(value).digest();
const files = ["index.mjs", "host.mjs", "runtime.mjs", "server.mjs", "fixtures.mjs",
  "../rooms-entry/index.mjs", "../rooms-entry/server.mjs", "../rooms-entry/host-proposal.mjs", "../whop-payments/controller.mjs",
  "../whop-payments/server.mjs", "../whop-payments/v2.mjs", "../fulfillment/index.mjs",
  "../auditor/audit.mjs", "../auditor/browser.mjs", "../auditor/network.mjs", "../auditor/delivery.mjs", "../auditor/fixtures.mjs",
  "../contracts/v2.schema.json"];
function buildFingerprint(app) {
  const source = Object.fromEntries(files.map((path) => [path, hash(readFileSync(new URL(path, import.meta.url))).toString("hex")]));
  const services = (app.service?.db.prepare("SELECT snapshot FROM services ORDER BY id").all() || []).map(({ snapshot }) => {
    const value = JSON.parse(snapshot);
    return Object.fromEntries(["id", "service_version", "prompt_version", "amount_minor", "currency", "execution_cap_minor", "allowed_actions"]
      .map((key) => [key, value[key]]));
  });
  const policy = Object.fromEntries(["purpose", "paid_work_enabled", "service_id", "delivery_timing", "refund_terms",
    "offer_ttl_ms", "deliverables", "acceptance_checks", "exclusions", "action_cost_minor"]
    .filter((key) => Object.hasOwn(app.policy, key)).map((key) => [key, app.policy[key]]));
  const manifest = { mode: app.mode, phase: app.phase, node: process.versions.node, source, services, policy };
  return { sha256: hash(JSON.stringify(manifest)).toString("hex"), manifest };
}
async function body(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw fail("JSON_REQUIRED", 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw fail("REQUEST_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(raw, allowed) {
  let value;
  try { value = JSON.parse(raw.toString("utf8")); } catch { throw fail("INVALID_JSON", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw fail("INVALID_INPUT", 400);
  return value;
}

// One listening server. Existing entry and signed-Whop handlers are mounted, not forked/reimplemented.
export function createIntegrationServer(app, { allocationToken, backendToken, operatorToken, fixture = null, automatic = true }) {
  const tokens = [allocationToken, backendToken, ...(app.service || fixture ? [operatorToken] : [])];
  for (const token of tokens)
    if (typeof token !== "string" || token.length < 32) throw fail("SERVER_ONLY_TOKEN_REQUIRED", 503);
  if (new Set(tokens).size !== tokens.length) throw fail("SEPARATE_SERVER_TOKENS_REQUIRED", 503);
  const entryHandler = createEntryServer(app.entry, { token: allocationToken });
  const fingerprint = buildFingerprint(app);
  const authorize = (req, token) => {
    const value = req.headers.authorization;
    if (typeof value !== "string" || value.length > 4096 || !timingSafeEqual(hash(`Bearer ${token}`), hash(value)))
      throw fail("FORBIDDEN", 401);
  };
  const authority = async (req) => {
    const value = await app.resolveAuthority({ capability: req.headers["x-wittle-room-capability"] });
    if (!value) throw fail("ROOM_AUTHORITY_REQUIRED", 403);
    return value;
  };
  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") return send(200, {
        state: app.mode === "fixture" ? "fixture_only" : "not_independently_accepted", mode: app.mode, phase: app.phase,
        evidence_level: "local_execution", sales_enabled: false, provider_acceptance: false,
        build: fingerprint, blockers: app.blockers(),
      });
      if (["/entry", "/readiness"].includes(path)) {
        req.url = path; entryHandler.emit("request", req, res); return;
      }
      if (path === "/api/webhooks/whop" && req.method === "POST") {
        if (!app.service) throw fail("PAID_WORK_DISABLED_FOR_FREE_SCOPING", 503);
        app.service.server.emit("request", req, res); return;
      }
      if (path === "/api/payment-snapshot" && req.method === "GET") {
        if (!app.service) throw fail("PAID_WORK_DISABLED_FOR_FREE_SCOPING", 503);
        authorize(req, operatorToken); return send(200, app.service.paymentSnapshot());
      }
      const routes = ["/events/rooms", "/api/brief", "/api/quote", "/api/order-status", "/api/result", "/api/revision"];
      const fixtureRoute = ["/fixture/payment", "/fixture/event"].includes(path) && fixture && app.mode === "fixture";
      if (!routes.includes(path) && !fixtureRoute) throw fail("NOT_FOUND", 404);
      if (req.method !== "POST") throw fail("METHOD_NOT_ALLOWED", 405);
      authorize(req, fixtureRoute ? operatorToken : backendToken);
      if (!app.service && !["/events/rooms", "/api/brief", "/fixture/event"].includes(path))
        throw fail("PAID_WORK_DISABLED_FOR_FREE_SCOPING", 503);
      const raw = await body(req);
      if (path === "/events/rooms") return send(200, await app.receiveRoomEvent({ raw, headers: req.headers }));
      if (path === "/fixture/payment") {
        const input = json(raw, ["quote_id", "refund"]);
        const payment = await fixture.payment(input);
        const tick = await app.tick({ discover: true });
        return send(200, { mode: "fixture", evidence_level: "fixture", payment, tick });
      }
      if (path === "/fixture/event") {
        const input = json(raw, ["buyer", "text", "kind", "scope_hash", "pages", "instructions", "id"]);
        const event = fixture.event(input);
        if (event.kind === "revision") {
          const current = app.host.inspect(event.room_id);
          if (!app.revise) throw fail("PAID_WORK_DISABLED_FOR_FREE_SCOPING", 503);
          return send(200, await app.revise(event.authority, { quote_id: current?.quote?.quote_id, event_id: event.id }));
        }
        return send(200, await app.receiveRoomEvent({ raw: Buffer.from(JSON.stringify(event)), headers: {} }));
      }
      const credential = await authority(req);
      if (path === "/api/brief") {
        json(raw, []); return send(200, await app.brief(credential));
      }
      if (path === "/api/quote") return send(200, await app.service.v2.quote(credential,
        json(raw, ["site_url", "scope_summary", "pages", "findings_cap", "request_id"])));
      if (path === "/api/order-status") return send(200, await app.orderStatus(credential, json(raw, ["quote_id"])));
      if (path === "/api/result") return send(200, await app.result(credential, json(raw, ["quote_id", "revision"])));
      return send(200, await app.revise(credential, json(raw, ["quote_id", "event_id"])));
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,99}$/.test(error.code) ? error.code : "REQUEST_UNAVAILABLE";
      return send(status, { code, retryable: status === 503, build: fingerprint.sha256 });
    }
  });
  let timer = null;
  if (automatic && app.tick) {
    timer = setInterval(() => { void app.tick().catch(() => console.error("INTEGRATION_TICK_FAILED")); }, 1000);
    timer.unref();
  }
  return { server, fingerprint,
    async close() {
      clearInterval(timer);
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await app.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] !== "--fixture") throw new Error("Only explicitly labeled --fixture startup is provided here. Real provider bindings require the authorized deployment owner; sales stay closed.");
  let directory, port = 3327, phase = "free_scoping";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--state") directory = args[++i];
    else if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--paid-fixture") phase = "paid_candidate";
    else throw new Error("Unknown startup argument");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local port");
  const { createFixture } = await import("./fixtures.mjs");
  const fixture = await createFixture({ directory, phase });
  const served = createIntegrationServer(fixture.app, { ...fixture.tokens, fixture });
  await new Promise((resolve, reject) => { served.server.once("error", reject); served.server.listen(port, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ state: "fixture_only", phase, url: `http://127.0.0.1:${served.server.address().port}`, build: served.fingerprint.sha256,
    directory: fixture.directory, blockers: fixture.app.blockers(), real_provider_calls: 0, sales_enabled: false }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void served.close().then(() => { process.exitCode = 0; }); });
}
