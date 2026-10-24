// Server-only free-scoping consumer of the Solari owner's bound Rooms transport.
// No auth/file loading, model tools, room creation, capability issuance or paid operations.
import { createHash } from 'node:crypto';
import { evaluateReadiness } from './index.mjs';

const fail = (code, status = 503) => Object.assign(new Error(code), { code, status });
const need = (ok, code, status) => { if (!ok) throw fail(code, status); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;

export function createConciergeAttesters({ transport, readReadiness, sourceAuthority, now = Date.now }) {
  const source = transport?.binding;
  need(source?.account === '@concierge' && source.mode === 'sandbox' &&
    [source.owner_id, source.agent_id, source.buyer_id, source.room_id].every(id) && source.owner_id !== source.buyer_id &&
    typeof source.join_url === 'string' && Number.isFinite(Date.parse(source.expires_at)) &&
    ['readRoom', 'readEvents', 'send'].every(name => typeof transport[name] === 'function') &&
    typeof readReadiness === 'function' && typeof sourceAuthority === 'function', 'CONCIERGE_BINDING_REQUIRED');
  let url;
  try { url = new URL(source.join_url); } catch { throw fail('CONCIERGE_BINDING_REQUIRED'); }
  need(url.origin === 'https://rooms.wittlelabs.ai' && !url.username && !url.password && !/[\s\\]/.test(source.join_url), 'CONCIERGE_BINDING_REQUIRED');
  const binding = Object.freeze(Object.fromEntries(['account', 'mode', 'owner_id', 'agent_id', 'buyer_id', 'room_id', 'join_url', 'expires_at'].map(key => [key, source[key]])));
  const membershipId = `member_${createHash('sha256').update(JSON.stringify([binding.room_id, binding.buyer_id])).digest('hex')}`;
  let lastBuyerSource = null;
  const checkTime = () => need(Date.parse(binding.expires_at) > now(), 'CONCIERGE_BINDING_EXPIRED');
  const expiry = room => new Date(Math.min(Date.parse(binding.expires_at), room.expires_at, now() + 30_000)).toISOString();
  function bound(input) {
    checkTime();
    need(input?.room_id === binding.room_id && (!Object.hasOwn(input, 'buyer_id') || input.buyer_id === binding.buyer_id), 'ROOM_BUYER_MISMATCH', 403);
  }
  async function currentRoom(signal, requireBuyer = false) {
    checkTime();
    const room = await transport.readRoom({ signal });
    checkTime();
    // Native quick rooms omit invite counts. This proves the current ACL, not an invitation lock.
    need(room?.room_id === binding.room_id && room.state === 'OPEN' && Number.isSafeInteger(room.expires_at) && room.expires_at > now() &&
      room.project_id == null && (!Object.hasOwn(room, 'pending_invites') || room.pending_invites === 0) && Array.isArray(room.members), 'PRIVATE_ROOM_UNVERIFIED');
    need(new Set(room.members.map(member => member.id)).size === room.members.length && room.members.every(member => {
      if (![binding.owner_id, binding.buyer_id].includes(member.id)) return false;
      if (member.agents !== undefined && !Array.isArray(member.agents)) return false;
      const references = [...(member.agents || []), ...(member.agent ? [member.agent] : [])];
      if (references.some(agent => !plain(agent) || (agent.id != null && !id(agent.id)))) return false;
      const agents = references.filter(agent => agent.id != null);
      return member.id === binding.owner_id ? agents.length > 0 && agents.every(agent => agent.id === binding.agent_id) : agents.length === 0;
    }), 'UNEXPECTED_ROOM_MEMBER');
    need(room.members.some(member => member.id === binding.owner_id), 'HOST_NOT_ADMITTED');
    if (requireBuyer) need(room.members.some(member => member.id === binding.buyer_id), 'BUYER_NOT_CURRENT_MEMBER', 403);
    return room;
  }
  async function readiness(signal) {
    checkTime();
    const value = await readReadiness({ mode: 'sandbox', purpose: 'free_scoping' }, { signal });
    checkTime();
    need(value?.mode === 'sandbox' && value.evidence_level === 'provider' &&
      evaluateReadiness(value.readiness, { now: now(), purpose: 'free_scoping' }).entry_available, 'RUNTIME_UNAVAILABLE');
    return value.readiness;
  }
  async function events({ cursor = 0, signal } = {}) {
    checkTime();
    const result = await transport.readEvents({ cursor, limit: 200, signal });
    checkTime();
    need(result?.room_id === binding.room_id && Array.isArray(result.events) && result.events.length <= 200 &&
      result.events.every(event => !event.room_id || event.room_id === binding.room_id), 'CANONICAL_EVENTS_REQUIRED');
    return result;
  }
  async function findEvent(messageId, position, signal) {
    need(id(messageId) && (position === undefined || (Number.isSafeInteger(position) && position > 0)), 'INVALID_SOURCE_REFERENCE', 400);
    // Bounded window for the dedicated NEW private test room, not a transcript/history broker.
    const result = await events({ cursor: position === undefined ? 0 : position - 1, signal });
    const found = result.events.filter(event => event.id === messageId);
    need(found.length === 1 && Number.isSafeInteger(found[0].position) && found[0].position > 0 &&
      (position === undefined || found[0].position === position), 'SOURCE_NOT_FOUND', 403);
    return found[0];
  }
  function buyerEvent(event) {
    // Native human events can carry agent:{name:...}; display labels are not an agent identity.
    return event?.type === 'MESSAGE' && event.sender === binding.buyer_id &&
      (event.agent == null || (plain(event.agent) && event.agent.id == null)) && id(event.id) &&
      Number.isSafeInteger(event.position) && event.position > 0 && text(event.message);
  }
  async function membership(input, { signal } = {}) {
    bound(input);
    if (!lastBuyerSource) {
      const result = await events({ signal });
      const candidates = result.events.filter(buyerEvent);
      need(candidates.length > 0, 'BUYER_SOURCE_REQUIRED', 403);
      lastBuyerSource = candidates.reduce((latest, event) => event.position > latest.position ? event : latest).id;
    }
    // Final observation occurs after any source lookup; a message does not prove current membership.
    const room = await currentRoom(signal, true);
    return { mode: 'sandbox', evidence_level: 'provider', buyer_id: binding.buyer_id, room_id: binding.room_id,
      membership_id: membershipId, source_event_id: lastBuyerSource,
      verified_at: new Date(now()).toISOString(), expires_at: expiry(room), revoked_at: null };
  }
  async function verifyRoom(input, { signal } = {}) {
    bound(input);
    need(input.mode === 'sandbox', 'ROOM_MODE_MISMATCH', 403);
    const ready = await readiness(signal);
    const history = await events({ signal });
    // Never recycle a room with previous buyer/unknown human traffic, even if they have left.
    need(history.has_more !== true && history.events.every(event => event.type !== 'MESSAGE' ||
      event.sender === binding.owner_id || event.sender === binding.buyer_id), 'ROOM_HISTORY_UNVERIFIED');
    const room = await currentRoom(signal);
    need(evaluateReadiness(ready, { now: now(), purpose: 'free_scoping' }).entry_available, 'RUNTIME_UNAVAILABLE');
    return { mode: 'sandbox', evidence_level: 'provider', room_id: binding.room_id, join_url: binding.join_url,
      private: true, host_lead_ready: true, unexpected_members: false,
      unused: !room.members.some(member => member.id === binding.buyer_id) && !history.events.some(event => event.type === 'MESSAGE' && event.sender === binding.buyer_id),
      observed_at: new Date(now()).toISOString(), expires_at: expiry(room) };
  }
  async function verifyRoomEvent(input, { signal } = {}) {
    let reference = input;
    if (input?.raw !== undefined) {
      need((typeof input.raw === 'string' || Buffer.isBuffer(input.raw)) && Buffer.byteLength(input.raw) <= 4096, 'INVALID_SOURCE_REFERENCE', 400);
      try { reference = JSON.parse(input.raw.toString()); } catch { throw fail('INVALID_SOURCE_REFERENCE', 400); }
    }
    need(plain(reference) && Object.keys(reference).every(key => ['room_id', 'message_id', 'position'].includes(key)), 'INVALID_SOURCE_REFERENCE', 400);
    bound(reference);
    const ready = await readiness(signal);
    const event = await findEvent(reference.message_id, reference.position, signal);
    if (!buyerEvent(event)) return null; // System/agent/own messages never become buyer authority or inference.
    const authority = await sourceAuthority({ buyer_id: binding.buyer_id, room_id: binding.room_id, source_event_id: event.id });
    need(typeof authority === 'string' && authority.length > 0, 'SOURCE_AUTHORITY_UNAVAILABLE', 403);
    lastBuyerSource = event.id;
    await membership({ buyer_id: binding.buyer_id, room_id: binding.room_id }, { signal });
    need(evaluateReadiness(ready, { now: now(), purpose: 'free_scoping' }).entry_available, 'RUNTIME_UNAVAILABLE');
    return { id: event.id, buyer_id: binding.buyer_id, actor_id: event.sender, room_id: binding.room_id,
      text: event.message, kind: 'message', position: event.position, authority };
  }
  async function sendHost(input, { signal } = {}) {
    bound(input);
    need(plain(input) && Object.keys(input).every(key => ['room_id', 'source_event_id', 'delivery_key', 'text'].includes(key)) &&
      id(input.source_event_id) && id(input.delivery_key) && text(input.text), 'INVALID_HOST_MESSAGE', 400);
    const ready = await readiness(signal);
    const original = await findEvent(input.source_event_id, undefined, signal);
    need(buyerEvent(original), 'REPLY_SOURCE_NOT_BUYER', 403);
    await currentRoom(signal, true);
    need(evaluateReadiness(ready, { now: now(), purpose: 'free_scoping' }).entry_available, 'RUNTIME_UNAVAILABLE');
    // The specialist transport owns durable send intents. Unknown outcomes are NEVER retried here.
    const receipt = await transport.send({ room_id: input.room_id, delivery_key: input.delivery_key, text: input.text }, { signal });
    need(receipt?.room_id === binding.room_id && receipt.delivery_key === input.delivery_key && id(receipt.message_id) &&
      Number.isSafeInteger(receipt.position) && receipt.position > 0, 'SEND_RECEIPT_UNVERIFIED');
    const event = await findEvent(receipt.message_id, receipt.position, signal);
    need(event.type === 'MESSAGE' && event.sender === binding.owner_id && event.agent?.id === binding.agent_id &&
      event.position > original.position && event.message === input.text, 'CANONICAL_REPLY_MISMATCH');
    return { room_id: binding.room_id, delivery_key: input.delivery_key, message_id: event.id, position: event.position };
  }
  return Object.freeze({ membership, verifyRoom, verifyRoomEvent, sendHost });
}
