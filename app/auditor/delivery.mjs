import { DatabaseSync } from 'node:sqlite';
import { auditScope, digest } from './audit.mjs';

const bindingKeys = ['order_id', 'job_id', 'attempt_id', 'room_id', 'buyer_id', 'quote_id', 'quote_hash', 'service_version', 'prompt_version', 'mode'];
function matches(job, other) {
  return bindingKeys.every(key => job[key] === other?.[key]) &&
    digest(job.scope) === (other.scope_hash || digest(other.scope));
}
export function createDelivery({ databasePath, authorize, send, readBuyerEvent }) {
  // This DB belongs on the trusted durable controller host, never the disposable VM.
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS audit_orders (
      order_id TEXT PRIMARY KEY, binding TEXT NOT NULL, revision_used INTEGER NOT NULL DEFAULT 0,
      rating INTEGER, rating_event TEXT, rating_position INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_reports (
      order_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      delivery_key TEXT NOT NULL UNIQUE, phase TEXT NOT NULL, message_id TEXT, delivered_at TEXT,
      PRIMARY KEY(order_id, revision)
    );`);
  const order = id => db.prepare('SELECT * FROM audit_orders WHERE order_id=?').get(id);
  const saved = (id, revision) => db.prepare('SELECT * FROM audit_reports WHERE order_id=? AND revision=?').get(id, revision);
  async function check(job, operation) {
    auditScope(job);
    const permission = await authorize({ job, operation });
    if (!permission?.allowed || !matches(job, permission) || permission.buyer_id !== job.buyer_id) throw new Error('PAID_JOB_NOT_AUTHORIZED');
    const previous = order(job.order_id);
    if (previous && !matches(job, JSON.parse(previous.binding))) throw new Error('ORDER_BINDING_MISMATCH');
  }
  async function buyerEvent(job, id) {
    const event = await readBuyerEvent(id);
    if (!event || event.id !== id || event.room_id !== job.room_id || event.actor_id !== job.buyer_id ||
        !Number.isSafeInteger(event.position) || event.position < 1) throw new Error('BUYER_EVENT_NOT_ATTRIBUTABLE');
    return event;
  }
  function persist(job, report, revision) {
    if (!matches(job, report) || report.prompt_version !== job.prompt_version || report.audit_mode !== 'paid') throw new Error('REPORT_BINDING_MISMATCH');
    const { report_hash, ...body } = report;
    if (digest(body) !== report_hash || !['complete', 'partial', 'failed'].includes(report.state)) throw new Error('INVALID_REPORT');
    if (job.mode !== 'fixture' && report.evidence_kind === 'fixture') throw new Error('FIXTURE_NOT_PROVIDER_PROOF');
    const key = `audit:${digest({ order: job.order_id, revision, report_hash })}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = order(job.order_id);
      if (current && !matches(job, JSON.parse(current.binding))) throw new Error('ORDER_BINDING_MISMATCH');
      db.prepare('INSERT OR IGNORE INTO audit_orders(order_id,binding) VALUES (?,?)').run(job.order_id, JSON.stringify(job));
      if (!saved(job.order_id, revision)) db.prepare('INSERT INTO audit_reports(order_id,revision,payload,delivery_key,phase) VALUES (?,?,?,?,?)').run(
        job.order_id, revision, JSON.stringify(report), key, report.state === 'complete' ? 'saved' : 'needs_attention');
      db.exec('COMMIT');
      return saved(job.order_id, revision);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async function deliver(job, revision = 0) {
    await check(job, 'deliver'); // payment/refund/cancel/lease rechecked before every new send
    const row = saved(job.order_id, revision);
    if (!row) throw new Error('REPORT_NOT_SAVED');
    if (row.phase === 'delivered') return { state: revision ? 'revised' : 'delivered', duplicate: true, message_id: row.message_id, delivery_key: row.delivery_key };
    if (row.phase !== 'saved') return { state: 'needs_attention', reason: 'OPERATOR_RECONCILIATION_REQUIRED', delivery_key: row.delivery_key };
    // Persist intent before network I/O. A restart in this state must never resend.
    const claim = db.prepare("UPDATE audit_reports SET phase='sending' WHERE order_id=? AND revision=? AND phase='saved'").run(job.order_id, revision);
    if (!claim.changes) return { state: 'needs_attention', reason: 'DELIVERY_ALREADY_CLAIMED' };
    try {
      const receipt = await send({ room_id: job.room_id, delivery_key: row.delivery_key, report: JSON.parse(row.payload), revision });
      if (!receipt?.message_id || receipt.room_id !== job.room_id || receipt.delivery_key !== row.delivery_key) throw new Error('SEND_RECEIPT_MISMATCH');
      db.prepare("UPDATE audit_reports SET phase='delivered',message_id=?,delivered_at=? WHERE order_id=? AND revision=?").run(receipt.message_id, new Date().toISOString(), job.order_id, revision);
      return { state: revision ? 'revised' : 'delivered', message_id: receipt.message_id, delivery_key: row.delivery_key };
    } catch {
      db.prepare("UPDATE audit_reports SET phase='needs_attention' WHERE order_id=? AND revision=?").run(job.order_id, revision);
      return { state: 'needs_attention', reason: 'OPERATOR_RECONCILIATION_REQUIRED', delivery_key: row.delivery_key };
    }
  }
  return {
    async fulfill(job, run) {
      await check(job, 'audit');
      if (!saved(job.order_id, 0)) {
        const report = await run(job);
        await check(job, 'persist_result');
        // Concurrent workers cannot replace a previously saved report.
        if (!saved(job.order_id, 0)) persist(job, report, 0);
      }
      return deliver(job);
    },
    deliver,
    async revise(job, { event_id, pages, instructions }, run) {
      await check(job, 'revise');
      const initial = saved(job.order_id, 0);
      if (initial?.phase !== 'delivered') throw new Error('REVISION_BEFORE_DELIVERY');
      const event = await buyerEvent(job, event_id);
      if (event.type !== 'revision' || event.instructions !== instructions || JSON.stringify(event.pages) !== JSON.stringify(pages)) throw new Error('REVISION_EVENT_MISMATCH');
      if (!Array.isArray(pages) || !pages.length || pages.some(url => !job.scope.pages.includes(url)) ||
          typeof instructions !== 'string' || !instructions.trim() || instructions.length > 2000 || event.in_scope !== true) throw new Error('REVISION_OUT_OF_SCOPE');
      const claim = db.prepare('UPDATE audit_orders SET revision_used=1 WHERE order_id=? AND revision_used=0').run(job.order_id);
      if (!claim.changes) throw new Error('REVISION_ALREADY_USED');
      // A failed/uncertain revision stays consumed; operators reconcile rather than reset counters.
      const report = await run(job, { pages, instructions, event_id });
      await check(job, 'persist_revision');
      persist(job, report, 1);
      return deliver(job, 1);
    },
    async rate(job, event_id) {
      await check(job, 'rate');
      const row = saved(job.order_id, 0);
      if (row?.phase !== 'delivered') throw new Error('RATING_BEFORE_DELIVERY');
      const event = await buyerEvent(job, event_id);
      if (event.type !== 'rating' || !Number.isInteger(event.value) || event.value < 1 || event.value > 5 || event.after_message_id !== row.message_id) throw new Error('INVALID_RATING');
      // Trusted provider event order, not request arrival order, determines the current rating.
      const update = db.prepare('UPDATE audit_orders SET rating=?,rating_event=?,rating_position=? WHERE order_id=? AND (rating_position IS NULL OR rating_position < ?)').run(event.value, event.id, event.position, job.order_id, event.position);
      return { state: saved(job.order_id, 1)?.phase === 'delivered' ? 'revised' : 'delivered', rating: order(job.order_id).rating, updated: Boolean(update.changes) };
    },
    async reconcile(job, { revision = 0, receipt }) {
      await check(job, 'operator_reconcile'); // trusted adapter must require operator capability
      const row = saved(job.order_id, revision);
      if (!row || JSON.parse(row.payload).state !== 'complete' || !receipt?.message_id || receipt.room_id !== job.room_id || receipt.delivery_key !== row.delivery_key) throw new Error('RECONCILIATION_MISMATCH');
      if (row.phase === 'delivered' && row.message_id !== receipt.message_id) throw new Error('RECONCILIATION_MISMATCH');
      db.prepare("UPDATE audit_reports SET phase='delivered',message_id=?,delivered_at=? WHERE order_id=? AND revision=? AND phase IN ('sending','needs_attention')").run(receipt.message_id, new Date().toISOString(), job.order_id, revision);
      return { state: revision ? 'revised' : 'delivered' };
    },
    records(orderId, revision = 0) {
      const row = saved(orderId, revision);
      if (!row) return null;
      const report = JSON.parse(row.payload);
      if (report.state !== 'complete') return { result: null, delivery: null };
      const artifactHash = digest(report);
      const binding = Object.fromEntries(['order_id', 'job_id', 'attempt_id', 'room_id', 'quote_hash', 'mode'].map(key => [key, report[key]]));
      const result = { ...binding, revision, report: { artifact_id: `audit-${artifactHash}`, sha256: artifactHash, media_type: 'application/json' },
        findings_count: report.findings.length, limitations: report.limitations, completed_at: report.completed_at };
      const delivery = row.phase === 'delivered' ? { ...binding, artifact_id: result.report.artifact_id, revision,
        message_id: row.message_id, delivered_at: row.delivered_at } : null;
      return { result, delivery };
    },
    inspect(orderId) {
      const current = order(orderId);
      return current ? { ...current, reports: db.prepare('SELECT * FROM audit_reports WHERE order_id=? ORDER BY revision').all(orderId) } : null;
    },
    close() { db.close(); },
  };
}
