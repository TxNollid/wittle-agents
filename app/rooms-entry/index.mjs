// Pool allocation only: provider ports below are read-only. No model/provider credentials enter this module.
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MODES = ['fixture', 'sandbox', 'live'];
const PURPOSES = ['paid', 'free_scoping'];
const READY_FIELDS = ['observed_at', 'expires_at', 'stale', 'available_slots', 'host_lead_ready', 'membership_ready', 'credential_boundary_verified', 'entry_available', 'quoting_available', 'reason'];
const REASONS = [null, 'runtime_expired', 'stale', 'capacity_full', 'membership_unverified', 'credential_boundary_unverified', 'host_unavailable', 'entry_unavailable', 'terms_unavailable', 'unknown'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? Date.parse(value) : NaN;

export class EntryError extends Error {
  constructor(code, status, nextAction, retryable = false) {
    super(code);
    this.code = code;
    this.status = status;
    this.body = { code, retryable, next_action: nextAction };
  }
}
const unavailable = () => new EntryError('RUNTIME_UNAVAILABLE', 503, 'wait', true);
const conflict = () => new EntryError('CONFLICT', 409, 'stop');
const forbidden = () => new EntryError('FORBIDDEN', 403, 'stop');
const invalid = () => new EntryError('INVALID_INPUT', 400, 'correct_input');

export function evaluateReadiness(value, { now = Date.now(), maxAgeMs = 30_000, minRemainingMs = 120_000, purpose = 'paid' } = {}) {
  const empty = { observed_at: new Date(now).toISOString(), expires_at: new Date(now).toISOString(), stale: true, available_slots: null, host_lead_ready: false, membership_ready: false, credential_boundary_verified: false, entry_available: false, quoting_available: false, reason: 'unknown' };
  if (!PURPOSES.includes(purpose) || !plain(value) || READY_FIELDS.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !READY_FIELDS.includes(key))) return empty;
  const observed = instant(value.observed_at), expires = instant(value.expires_at);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now || expires <= observed || !REASONS.includes(value.reason) ||
      READY_FIELDS.slice(4, 9).some(key => typeof value[key] !== 'boolean') || typeof value.stale !== 'boolean' ||
      !(value.available_slots === null || (Number.isSafeInteger(value.available_slots) && value.available_slots >= 0))) return empty;
  // Only the paid-terms denial is irrelevant to free scoping. All source safety denials remain binding.
  let reason = purpose === 'free_scoping' && !value.quoting_available && value.reason === 'terms_unavailable' ? null : value.reason;
  if (expires <= now) reason = 'runtime_expired';
  else if (value.stale || now - observed > maxAgeMs) reason = 'stale';
  else if (!value.credential_boundary_verified) reason = 'credential_boundary_unverified';
  else if (!value.membership_ready) reason = 'membership_unverified';
  else if (!value.host_lead_ready) reason = 'host_unavailable';
  else if (!(value.available_slots > 0)) reason = 'capacity_full';
  else if (expires - now < minRemainingMs) reason = 'runtime_expired';
  else if (!value.entry_available) reason = 'entry_unavailable';
  else if (purpose === 'paid' && !value.quoting_available) reason = 'terms_unavailable';
  return { ...value, stale: value.stale || now - observed > maxAgeMs, entry_available: reason === null, quoting_available: purpose === 'paid' && reason === null, reason };
}

// The caller supplies a private, durable entry-only SQLite connection (node:sqlite DatabaseSync).
// readReadiness/verifyRoom are trusted backend ports, NEVER supplied by HTTP request data.
export function createEntryAdapter(db, {
  mode = 'fixture', enabled = false, liveReleaseApproved = false, purpose = 'paid',
  roomsOrigin = 'https://rooms.wittlelabs.ai', maxReadinessAgeMs = 30_000,
  maxRoomProofAgeMs = 30_000, minRemainingMs = 120_000, portTimeoutMs = 2_000,
} = {}, { now = () => Date.now(), readReadiness, verifyRoom } = {}) {
  const origin = new URL(roomsOrigin);
  if (!MODES.includes(mode) || !PURPOSES.includes(purpose) || typeof enabled !== 'boolean' || typeof liveReleaseApproved !== 'boolean' ||
      origin.origin !== roomsOrigin || origin.protocol !== 'https:' || origin.username || origin.password ||
      ![maxReadinessAgeMs, maxRoomProofAgeMs, minRemainingMs, portTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) throw invalid();
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS entry_config (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, origin TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entry_rooms (room_id TEXT PRIMARY KEY, join_url TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entry_allocations (request_id TEXT PRIMARY KEY, entry_principal_id TEXT UNIQUE NOT NULL, ref TEXT, room_id TEXT UNIQUE NOT NULL REFERENCES entry_rooms(room_id), allocated_at TEXT NOT NULL, expires_at TEXT NOT NULL);`);
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  transaction(() => {
    const saved = db.prepare('SELECT mode, origin FROM entry_config WHERE id=1').get();
    if (saved && (saved.mode !== mode || saved.origin !== roomsOrigin)) throw conflict();
    if (!saved) db.prepare('INSERT INTO entry_config VALUES (1,?,?)').run(mode, roomsOrigin);
  });
  const readAllocation = db.prepare('SELECT a.*, r.join_url FROM entry_allocations a JOIN entry_rooms r USING(room_id) WHERE request_id=?');
  const readRoomBinding = db.prepare('SELECT a.*, r.join_url FROM entry_allocations a JOIN entry_rooms r USING(room_id) WHERE room_id=?');
  const readPrincipal = db.prepare('SELECT request_id FROM entry_allocations WHERE entry_principal_id=?');
  const roomUsed = db.prepare('SELECT request_id FROM entry_allocations WHERE room_id=?');
  const listAvailable = db.prepare('SELECT r.* FROM entry_rooms r LEFT JOIN entry_allocations a USING(room_id) WHERE a.room_id IS NULL ORDER BY r.room_id');
  const insertAllocation = db.prepare('INSERT INTO entry_allocations VALUES (?,?,?,?,?,?)');

  function validateRoom(room) {
    if (!plain(room) || Object.keys(room).some(key => !['room_id', 'join_url', 'expires_at', 'mode'].includes(key)) ||
        !matches(ID, room.room_id) || room.mode !== mode || !Number.isFinite(instant(room.expires_at)) || instant(room.expires_at) <= now() ||
        typeof room.join_url !== 'string' || room.join_url.length > 2000 || /[\s\\]/.test(room.join_url)) throw invalid();
    let url;
    try { url = new URL(room.join_url); } catch { throw invalid(); }
    if (url.origin !== roomsOrigin || url.username || url.password) throw invalid();
  }
  function addRooms(rooms) {
    if (!Array.isArray(rooms) || rooms.length === 0) throw invalid();
    rooms.forEach(validateRoom);
    transaction(() => {
      for (const room of rooms) {
        const saved = db.prepare('SELECT * FROM entry_rooms WHERE room_id=?').get(room.room_id);
        if (saved) {
          if (saved.join_url !== room.join_url || saved.expires_at !== room.expires_at) throw conflict();
        } else {
          if (db.prepare('SELECT room_id FROM entry_rooms WHERE join_url=?').get(room.join_url)) throw conflict();
          db.prepare('INSERT INTO entry_rooms VALUES (?,?,?)').run(room.room_id, room.join_url, room.expires_at);
        }
      }
    });
  }
  async function trustedRead(port, input, allowNegativeReadiness = false) {
    if (typeof port !== 'function') throw unavailable();
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => port(input, { signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, portTimeoutMs); }),
      ]);
      // Evidence labels come from configured trusted ports, not a shape-valid request or the model.
      if (!plain(result) || result.mode !== mode) throw unavailable();
      const negative = allowNegativeReadiness && result.evidence_level === 'local_execution' && !assess(result.readiness).entry_available;
      if (!negative && result.evidence_level !== (mode === 'fixture' ? 'fixture' : 'provider')) throw unavailable();
      return result;
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  const assess = source => evaluateReadiness(source, { now: now(), maxAgeMs: maxReadinessAgeMs, minRemainingMs, purpose });
  async function readiness() {
    if (!enabled || (mode === 'live' && !liveReleaseApproved)) return { ...assess(null), reason: 'entry_unavailable' };
    try { return assess((await trustedRead(readReadiness, { mode, purpose }, true)).readiness); }
    catch { return assess(null); }
  }
  async function checkRoom(room, allocated) {
    const proof = await trustedRead(verifyRoom, { room_id: room.room_id, mode });
    const observed = instant(proof.observed_at), expires = instant(proof.expires_at);
    if (proof.room_id !== room.room_id || proof.join_url !== room.join_url || proof.private !== true || proof.host_lead_ready !== true || proof.unexpected_members !== false ||
        (!allocated && proof.unused !== true) || !Number.isFinite(observed) || !Number.isFinite(expires) ||
        observed > now() || now() - observed > maxRoomProofAgeMs || expires <= now()) throw unavailable();
    return proof;
  }
  function existing(principal, request) {
    const row = readAllocation.get(request.request_id);
    if (row) {
      if (row.entry_principal_id !== principal) throw forbidden();
      if (row.ref !== (request.ref ?? null)) throw conflict();
      return row;
    }
    if (readPrincipal.get(principal)) throw conflict();
    return null;
  }
  const response = row => ({ room_id: row.room_id, join_url: row.join_url, expires_at: row.expires_at, mode });
  async function returnExisting(row, ready) {
    if (!assess(ready).entry_available || instant(row.expires_at) <= now()) throw unavailable();
    const proof = await checkRoom(row, true);
    if (!assess(ready).entry_available || instant(proof.expires_at) <= now() || instant(row.expires_at) <= now()) throw unavailable();
    return response(row);
  }
  // Server-only composition port. Caller must independently verify the buyer's current
  // Rooms membership; a persisted entry allocation is NOT buyer/controller authority.
  async function getRoomBinding(roomId) {
    if (!matches(ID, roomId)) throw invalid();
    const row = readRoomBinding.get(roomId);
    if (!row) throw forbidden();
    return returnExisting(row, await readiness());
  }
  async function allocate(principal, request) {
    if (!matches(ID, principal) || !plain(request) || Object.keys(request).some(key => !['request_id', 'ref'].includes(key)) ||
        !matches(KEY, request.request_id) || (Object.hasOwn(request, 'ref') && !matches(ID, request.ref))) throw invalid();
    // Binding checks precede all provider reads and never disclose a different principal's join link.
    const prior = existing(principal, request);
    const ready = await readiness();
    if (!ready.entry_available) throw unavailable();
    if (prior) return returnExisting(prior, ready);
    for (const room of listAvailable.all()) {
      if (instant(room.expires_at) <= now()) continue;
      let proof;
      try { proof = await checkRoom(room, false); }
      catch (error) {
        const raced = existing(principal, request);
        if (raced) return returnExisting(raced, ready);
        if (roomUsed.get(room.room_id)) continue;
        throw error;
      }
      const outcome = transaction(() => {
        const raced = existing(principal, request);
        if (raced) return { existing: raced };
        if (!assess(ready).entry_available || instant(room.expires_at) <= now() || instant(proof.expires_at) <= now() || now() - instant(proof.observed_at) > maxRoomProofAgeMs) throw unavailable();
        if (roomUsed.get(room.room_id)) return null;
        const row = { ...room, allocated_at: new Date(now()).toISOString(), expires_at: new Date(Math.min(instant(room.expires_at), instant(ready.expires_at))).toISOString() };
        insertAllocation.run(request.request_id, principal, request.ref ?? null, room.room_id, row.allocated_at, row.expires_at);
        return { created: row };
      });
      if (outcome?.existing) return returnExisting(outcome.existing, ready);
      if (outcome?.created) return response(outcome.created);
      // Another process reserved this candidate while its read-only proof was in flight.
    }
    throw unavailable();
  }
  return { addRooms, allocate, readiness, getRoomBinding };
}
