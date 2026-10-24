import { hashOffer as digest } from "../fulfillment/index.mjs";
import { publicUrl } from "../auditor/network.mjs";

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const need = (ok, code, status) => { if (!ok) throw fail(code, status); };
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 2000;
const fields = new Set(["site_url", "pages", "excluded_pages", "goal", "constraints", "scope_summary", "findings_cap"]);
function validateBrief(value) {
  need(value && typeof value === "object" && !Array.isArray(value), "INVALID_BRIEF", 400);
  for (const [key, item] of Object.entries(value)) {
    need(fields.has(key), "FORBIDDEN_BRIEF_FIELD", 400);
    if (key === "site_url") publicUrl(item);
    else if (["pages", "excluded_pages"].includes(key)) {
      need(Array.isArray(item) && item.length <= (key === "pages" ? 5 : 20) &&
        new Set(item).size === item.length && (key !== "pages" || item.length > 0), "INVALID_PAGES", 400);
      item.forEach(publicUrl);
    } else if (key === "constraints") need(Array.isArray(item) && item.length <= 20 && item.every(text), "INVALID_CONSTRAINTS", 400);
    else if (key === "findings_cap") need(Number.isInteger(item) && item >= 1 && item <= 10, "INVALID_FINDINGS_CAP", 400);
    else need(text(item), "INVALID_BRIEF_TEXT", 400);
  }
  if (value.site_url && value.pages) {
    const origin = publicUrl(value.site_url).origin;
    need(value.pages.every((url) => publicUrl(url).origin === origin) &&
      !(value.excluded_pages || []).some((url) => value.pages.includes(url)), "INVALID_PAGE_SCOPE", 400);
  }
}
const complete = (brief) => [...fields].every((key) => Object.hasOwn(brief, key));

// State belongs to the trusted integration supervisor. Events are independently verified before arrival here.
export function createHost({ db, mode, now = Date.now, propose, feasible, issueQuote, orderStatus, send, authorize, quoteEnabled = true }) {
  need(["fixture", "sandbox"].includes(mode) && typeof quoteEnabled === "boolean", "INVALID_HOST_MODE", 503);
  for (const port of [propose, send, authorize, ...(quoteEnabled ? [feasible, issueQuote, orderStatus] : [])])
    need(typeof port === "function", "HOST_PORT_UNAVAILABLE", 503);
  const usableFeasibility = (proof, scopeHash) => proof?.ok === true && proof.mode === mode &&
    proof.evidence_level === (mode === "fixture" ? "fixture" : "provider") && proof.scope_hash === scopeHash &&
    Date.parse(proof.observed_at) <= now() && now() - Date.parse(proof.observed_at) <= 60000 &&
    Date.parse(proof.expires_at) > now();
  db.exec(`CREATE TABLE IF NOT EXISTS integration_briefs (
    room_id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 0, agreed_hash TEXT, quote TEXT,
    replies_used INTEGER NOT NULL DEFAULT 0, no_progress INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, paused TEXT
  );
  CREATE TABLE IF NOT EXISTS integration_host_events (
    event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    phase TEXT NOT NULL, result TEXT, reply_key TEXT NOT NULL UNIQUE, receipt TEXT
  )`);
  const room = (id) => db.prepare("SELECT * FROM integration_briefs WHERE room_id=?").get(id);
  const savedEvent = (id) => db.prepare("SELECT * FROM integration_host_events WHERE event_id=?").get(id);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const view = (id) => {
    const state = room(id);
    return state ? { buyer_id: state.buyer_id, room_id: id, brief: JSON.parse(state.brief), scope_hash: digest(JSON.parse(state.brief)),
      scope_version: state.version, replies_used: state.replies_used, remaining: Math.max(0, 12 - state.replies_used),
      scope_agreed: state.agreed_hash === digest(JSON.parse(state.brief)),
      paused: state.paused, quote: state.quote ? JSON.parse(state.quote) : null } : null;
  };
  const active = new Map();
  async function deliver(event, result) {
    await authorize(event, "reply");
    const saved = savedEvent(event.id);
    if (saved.phase === "sent") return { ...JSON.parse(saved.result), message_id: JSON.parse(saved.receipt).message_id };
    if (saved.phase !== "ready") return { state: "needs_attention", reason: "HOST_SEND_RECONCILIATION_REQUIRED" };
    const claimed = db.prepare("UPDATE integration_host_events SET phase='sending' WHERE event_id=? AND phase='ready'").run(event.id);
    if (!claimed.changes) return { state: "needs_attention", reason: "HOST_SEND_RECONCILIATION_REQUIRED" };
    try {
      const receipt = await send({ room_id: event.room_id, source_event_id: event.id, delivery_key: saved.reply_key, text: result.reply });
      need(receipt?.room_id === event.room_id && receipt.delivery_key === saved.reply_key && text(receipt.message_id) &&
        Number.isSafeInteger(receipt.position) && receipt.position > 0, "HOST_RECEIPT_MISMATCH");
      db.prepare("UPDATE integration_host_events SET phase='sent',receipt=? WHERE event_id=? AND phase='sending'")
        .run(JSON.stringify(receipt), event.id);
      return { ...result, message_id: receipt.message_id };
    } catch {
      db.prepare("UPDATE integration_host_events SET phase='needs_attention' WHERE event_id=? AND phase='sending'").run(event.id);
      return { state: "needs_attention", reason: "HOST_SEND_RECONCILIATION_REQUIRED" };
    }
  }
  async function once(event) {
    need(text(event.id) && text(event.room_id) && text(event.buyer_id) && text(event.text) &&
      Number.isSafeInteger(event.position) && event.position > 0 &&
      ["message", "scope_agreed"].includes(event.kind), "INVALID_SOURCE_EVENT", 400);
    await authorize(event, "scope");
    const hash = digest({ id: event.id, room_id: event.room_id, buyer_id: event.buyer_id,
      text: event.text, kind: event.kind, position: event.position, scope_hash: event.scope_hash || null });
    const previous = savedEvent(event.id);
    if (previous) {
      need(previous.room_id === event.room_id && previous.payload_hash === hash, "SOURCE_EVENT_CONFLICT", 403);
      if (previous.phase === "sent") return { ...JSON.parse(previous.result), message_id: JSON.parse(previous.receipt).message_id };
      if (previous.phase === "ready") return deliver(event, JSON.parse(previous.result));
      return { state: "needs_attention", reason: "HOST_EVENT_RECONCILIATION_REQUIRED" };
    }
    const state = transaction(() => {
      db.prepare("INSERT OR IGNORE INTO integration_briefs(room_id,buyer_id,started_at) VALUES (?,?,?)")
        .run(event.room_id, event.buyer_id, now());
      const current = room(event.room_id);
      need(current.buyer_id === event.buyer_id, "BUYER_ROOM_MISMATCH", 403);
      db.prepare("INSERT INTO integration_host_events VALUES (?,?,?,'reserved',NULL,?,NULL)")
        .run(event.id, event.room_id, hash, `host_${digest(event.id)}`);
      if (!current.paused && (current.replies_used >= 12 || now() - current.started_at >= 600000))
        db.prepare("UPDATE integration_briefs SET paused=? WHERE room_id=?")
          .run(current.replies_used >= 12 ? "quota_exhausted" : "scoping_time_exhausted", event.room_id);
      const latest = room(event.room_id);
      if (!latest.paused) db.prepare("UPDATE integration_briefs SET replies_used=replies_used+1 WHERE room_id=?").run(event.room_id);
      return view(event.room_id);
    });
    let reply, quote = null;
    try {
      if (event.kind === "scope_agreed" || (complete(state.brief) && event.text.trim().toLowerCase() === "yes")) {
        const presented = db.prepare("SELECT result,receipt FROM integration_host_events WHERE room_id=? AND phase='sent' ORDER BY rowid DESC LIMIT 1").get(event.room_id);
        need(complete(state.brief) && presented && JSON.parse(presented.result).scope_hash === state.scope_hash &&
          JSON.parse(presented.receipt).position < event.position &&
          (event.kind !== "scope_agreed" || event.scope_hash === state.scope_hash), "SCOPE_AGREEMENT_MISMATCH", 409);
        // Free agreement is attributable conversation state, NOT payment acceptance or paid readiness.
        db.prepare("UPDATE integration_briefs SET agreed_hash=? WHERE room_id=? AND brief=?")
          .run(state.scope_hash, event.room_id, JSON.stringify(state.brief));
        reply = "System: Your exact free scope is agreed and saved. Checkout is unavailable until paid feasibility and service terms are verified. No payment or audit has been authorized.";
        if (!state.paused && quoteEnabled) {
          let feasibility;
          try { feasibility = await feasible({ room_id: event.room_id, buyer_id: event.buyer_id, brief: structuredClone(state.brief) }); }
          catch (error) {
            if (error.status !== 503 && error.code !== "FEASIBILITY_UNAVAILABLE") throw error;
          }
          const canQuote = usableFeasibility(feasibility, state.scope_hash);
          if (canQuote) {
            await authorize(event, "quote");
            if (Date.parse(feasibility.expires_at) > now()) {
              try {
                quote = await issueQuote(event, { site_url: state.brief.site_url, scope_summary: state.brief.scope_summary,
                  pages: state.brief.pages, findings_cap: state.brief.findings_cap,
                  request_id: `quote_${digest(event.room_id).slice(0, 40)}_${state.scope_version}` });
              } catch (error) { if (error.status !== 503) throw error; }
            }
          }
        }
        if (quote) {
          db.prepare("UPDATE integration_briefs SET quote=?,no_progress=0 WHERE room_id=?").run(JSON.stringify(quote), event.room_id);
          reply = "Host: Payment accepts ONLY this frozen offer. Review all scope, exclusions, price, timing, refund terms and expiry before paying.\n" +
            JSON.stringify(quote.offer, null, 2) + "\nCheckout: " + quote.checkout_url;
        }
      } else if (state.paused) reply = "System: Free scoping is paused. Your brief is saved; no payment is required to finish unagreed scope.";
      else {
        const proposal = await propose({ ...structuredClone(state),
          event: { id: event.id, text: event.text, kind: event.kind, position: event.position } });
        need(proposal && Object.keys(proposal).every((key) => ["role", "reply", "brief_update", "tool_call", "pause_reason"].includes(key)) &&
          ["host", "auditor"].includes(proposal.role) && (proposal.reply === null || text(proposal.reply)) &&
          (proposal.pause_reason === null || ["quota_exhausted", "no_progress", "runtime_unavailable", "unsupported", "terms_unavailable"].includes(proposal.pause_reason)),
        "INVALID_HOST_PROPOSAL", 400);
        validateBrief(proposal.brief_update);
        const brief = { ...state.brief, ...proposal.brief_update };
        validateBrief(brief);
        const changed = digest(brief) !== state.scope_hash;
        const current = room(event.room_id);
        const noProgress = changed ? 0 : current.no_progress + 1;
        const paused = proposal.pause_reason || (noProgress >= 3 ? "no_progress" :
          current.replies_used === 12 && !complete(brief) ? "quota_exhausted" : null);
        db.prepare("UPDATE integration_briefs SET brief=?,version=version+?,agreed_hash=CASE WHEN ? THEN NULL ELSE agreed_hash END,no_progress=?,paused=? WHERE room_id=?")
          .run(JSON.stringify(brief), Number(changed), Number(changed), noProgress, paused, event.room_id);
        reply = `${proposal.role === "host" ? "Host" : "Auditor"}: ${proposal.reply || "Your brief is saved."}`;
        if (proposal.tool_call !== null) {
          need(proposal.tool_call && Object.keys(proposal.tool_call).every((key) => ["operation", "arguments"].includes(key)), "INVALID_TOOL_PROPOSAL", 400);
          // Quote requires the independently verified scope-agreement event above, not a model assertion.
          need(quoteEnabled && proposal.tool_call.operation === "order_status" && current.quote, "HOST_OPERATION_FORBIDDEN", 403);
          const q = JSON.parse(current.quote);
          need(proposal.tool_call.arguments?.quote_id === q.quote_id && Object.keys(proposal.tool_call.arguments).length === 1,
            "HOST_OPERATION_FORBIDDEN", 403);
          const status = await orderStatus(event, { quote_id: q.quote_id });
          reply += "\nOrder status: " + status.state;
        }
        if (paused) reply = "Host: Free scoping is paused. Your brief is saved; next step is to resolve " + paused + ". No payment is required for unfinished scope.";
        reply += "\nScope draft: " + JSON.stringify(brief) + (complete(brief) ? "\nConfirm this exact scope to request the frozen offer." : "\nPlease supply the missing scope fields.");
      }
      const result = { state: quote ? "quoted" : view(event.room_id).scope_agreed ? "agreed" : room(event.room_id).paused ? "paused" : "scoping",
        ...view(event.room_id), reply };
      db.prepare("UPDATE integration_host_events SET phase='ready',result=? WHERE event_id=? AND phase='reserved'")
        .run(JSON.stringify(result), event.id);
      return deliver(event, result);
    } catch (error) {
      db.prepare("UPDATE integration_host_events SET phase='needs_attention' WHERE event_id=? AND phase='reserved'").run(event.id);
      throw error;
    }
  }
  function handle(input) {
    const event = structuredClone(input);
    const key = event.room_id;
    if (active.has(key)) return active.get(key).then(() => handle(event), () => handle(event));
    const work = once(event).finally(() => active.delete(key));
    active.set(key, work); return work;
  }
  function terms(cap, request, policy, feasibility) {
    need(quoteEnabled, "PAID_WORK_DISABLED_FOR_FREE_SCOPING", 503);
    const current = view(cap.room_id);
    need(current?.buyer_id === cap.buyer_id && complete(current.brief) && room(cap.room_id).agreed_hash === current.scope_hash,
      "SAVED_AGREEMENT_REQUIRED", 409);
    need(usableFeasibility(feasibility, current.scope_hash), "FEASIBILITY_UNAVAILABLE", 503);
    const brief = current.brief;
    need(request.site_url === brief.site_url && request.scope_summary === brief.scope_summary &&
      digest(request.pages) === digest(brief.pages) && request.findings_cap === brief.findings_cap, "SAVED_SCOPE_MISMATCH", 409);
    need(policy && text(policy.service_id) && text(policy.delivery_timing) && text(policy.refund_terms), "SERVICE_TERMS_UNAVAILABLE", 503);
    return { service_id: policy.service_id, scope: { ...brief, viewports: ["desktop", "mobile"], revisions: 1,
      deliverables: policy.deliverables, acceptance_checks: policy.acceptance_checks, exclusions: policy.exclusions,
      required_inputs: [], allowed_actions: ["browse_public_pages", "write_audit_report", "deliver_in_bound_room"],
      delivery_timing: policy.delivery_timing, refund_terms: policy.refund_terms } };
  }
  return { handle, inspect: view, terms,
    async idle() { while (active.size) await Promise.allSettled([...active.values()]); },
  };
}
