// SYNTHETIC protocol fixtures only. Never use as provider/readiness/auth evidence or a live fallback.
// Sandbox-shaped fields exercise the actual specialist transport's strict interface; no native call occurs.
import { DatabaseSync } from 'node:sqlite';
import { createConciergeRoomsTransport } from '../solari-agent/concierge-rooms-transport.mjs';
import { createConciergeAttesters } from './concierge-attesters.mjs';

export function conciergeFixture({ now = Date.now } = {}) {
  const binding = { account: '@concierge', mode: 'sandbox', owner_id: 'synthetic_concierge_owner',
    agent_id: 'synthetic_concierge_host', buyer_id: 'synthetic_buyer', room_id: 'synthetic_private_room',
    join_url: 'https://rooms.wittlelabs.ai/j/synthetic_private_only?claim=fixture%2Ftoken',
    expires_at: new Date(now() + 3_600_000).toISOString() };
  const host = { id: binding.owner_id, handle: '@concierge', agents: [{ id: binding.agent_id }], agent: { id: binding.agent_id } };
  const room = { room_id: binding.room_id, state: 'OPEN', expires_at: now() + 3_600_000,
    members: [host], handling_agents: [{ id: binding.agent_id }] };
  const events = [], calls = [];
  const state = { authority: 'synthetic_free_authority_only', afterAuthority: null, onSend: null, failAfterSend: false,
    readiness: { stale: false, available_slots: 1, host_lead_ready: true, membership_ready: true,
      credential_boundary_verified: true, entry_available: true, quoting_available: false, reason: null } };
  function addEvent(event) {
    const saved = { id: `synthetic_message_${events.length + 1}`, type: 'MESSAGE', at: now(), room_id: binding.room_id,
      position: events.reduce((max, value) => Math.max(max, value.position), 0) + 1, ...event };
    events.push(saved); return saved;
  }
  function admitBuyer() {
    if (!room.members.some(member => member.id === binding.buyer_id)) room.members.push({
      id: binding.buyer_id, agents: [{ name: 'Synthetic browser label' }], agent: { name: 'Synthetic browser label' },
    });
  }
  const db = new DatabaseSync(':memory:');
  const call = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'get_profile') return { id: binding.owner_id, current_agent: { id: binding.agent_id } };
    if (name === 'read_account' && args.action === 'address') return { handle: 'concierge' };
    if (name === 'read_room' && args.action === 'get') return structuredClone(room);
    if (name === 'read_room' && args.action === 'events') {
      const remaining = events.filter(event => event.position > args.cursor);
      const page = remaining.slice(0, args.limit);
      return { room_id: binding.room_id, events: structuredClone(page), has_more: remaining.length > page.length,
        cursor: page.at(-1)?.position ?? args.cursor };
    }
    if (name === 'room' && args.action === 'send') {
      const event = addEvent({ sender: binding.owner_id, agent: { id: binding.agent_id }, message: args.message });
      state.onSend?.(event);
      if (state.failAfterSend) throw new Error('Synthetic lost provider acknowledgment');
      // Deliberately minimal native receipt: the attester must independently verify its canonical agent/owner/text.
      return { id: event.id, position: event.position };
    }
    throw new Error('Unsupported synthetic fixture call');
  };
  const readReadiness = async () => ({ mode: 'sandbox', evidence_level: 'provider', readiness: {
    observed_at: new Date(now()).toISOString(), expires_at: new Date(now() + 600_000).toISOString(), ...state.readiness,
  } });
  const sourceAuthority = async () => { await state.afterAuthority?.(); return state.authority; };
  const transport = createConciergeRoomsTransport({ binding, call, db, now });
  const attesters = createConciergeAttesters({ transport, readReadiness, sourceAuthority, now });
  return { binding, room, events, calls, state, transport, attesters, readReadiness,
    addEvent, admitBuyer, close: () => db.close() };
}
