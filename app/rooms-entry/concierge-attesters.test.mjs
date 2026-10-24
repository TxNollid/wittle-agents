import test from 'node:test';
import assert from 'node:assert/strict';
import { conciergeFixture } from './concierge-fixtures.mjs';

function setup(t) {
  let time = Date.parse('2026-10-24T20:00:00.000Z');
  const f = conciergeFixture({ now: () => time });
  t.after(() => f.close());
  return { ...f, advance: ms => { time += ms; } };
}
const ref = (f, e) => ({ room_id: f.binding.room_id, message_id: e.id, position: e.position });
const source = (f, message = 'Please scope this public site') => f.addEvent({ sender: f.binding.buyer_id, agent: null, message });
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const sends = f => f.calls.filter(call => call.name === 'room').length;

test('callback claims cannot replace canonical buyer, text, room, position or authority', async t => {
  const f = setup(t); f.admitBuyer();
  const event = source(f);
  event.agent = { name: 'Display label is not stable agent identity' };
  f.room.members.find(member => member.id === f.binding.buyer_id).agent = { name: 'Browser display label' };
  const before = f.calls.length;
  for (const injected of [{ buyer_id: 'forged' }, { text: 'forged' }, { kind: 'scope_agreed' }, { authority: 'forged' }])
    await rejects(f.attesters.verifyRoomEvent({ ...ref(f, event), ...injected }), 'INVALID_SOURCE_REFERENCE');
  await rejects(f.attesters.verifyRoomEvent({ ...ref(f, event), room_id: 'other_room' }), 'ROOM_BUYER_MISMATCH');
  assert.equal(f.calls.length, before);
  await rejects(f.attesters.verifyRoomEvent({ ...ref(f, event), position: event.position + 1 }), 'SOURCE_NOT_FOUND');
  const normalized = await f.attesters.verifyRoomEvent({ raw: Buffer.from(JSON.stringify(ref(f, event))) });
  assert.deepEqual(normalized, { id: event.id, buyer_id: f.binding.buyer_id, actor_id: f.binding.buyer_id,
    room_id: f.binding.room_id, text: event.message, kind: 'message', position: event.position, authority: f.state.authority });
  const member = await f.attesters.membership({ buyer_id: f.binding.buyer_id, room_id: f.binding.room_id });
  assert.match(member.membership_id, /^[A-Za-z0-9_-]{1,200}$/); // Frozen CapabilityRecord Id, not a credential.
  const impersonation = f.addEvent({ sender: 'synthetic_outsider', sender_handle: '@synthetic_buyer', message: 'yes', agent: null });
  assert.equal(await f.attesters.verifyRoomEvent(ref(f, impersonation)), null);
  const automated = f.addEvent({ sender: f.binding.buyer_id, agent: { id: 'other_agent' }, message: 'yes' });
  assert.equal(await f.attesters.verifyRoomEvent(ref(f, automated)), null);
});

test('membership is re-read after authority awaits and never inferred from a source message', async t => {
  const f = setup(t); f.admitBuyer();
  const event = source(f);
  f.state.afterAuthority = () => { f.room.members = f.room.members.filter(member => member.id !== f.binding.buyer_id); };
  await rejects(f.attesters.verifyRoomEvent(ref(f, event)), 'BUYER_NOT_CURRENT_MEMBER');
  await rejects(f.attesters.membership({ room_id: f.binding.room_id, buyer_id: f.binding.buyer_id }), 'BUYER_NOT_CURRENT_MEMBER');
  assert.equal(sends(f), 0);
});

test('extra agents, pending invitations, project visibility and binding expiry deny private proof', async t => {
  for (const mutate of [
    f => { f.room.members.push({ id: 'unexpected_member', agents: [] }); },
    f => { f.room.members[0].agents.push({ id: 'unexpected_agent' }); },
    f => { f.room.pending_invites = 1; },
    f => { f.room.project_id = 'shared_project'; },
  ]) {
    const f = setup(t); mutate(f);
    await assert.rejects(f.attesters.verifyRoom({ room_id: f.binding.room_id, mode: 'sandbox' }));
    assert.equal(sends(f), 0);
  }
  const f = setup(t); f.advance(3_600_001);
  await rejects(f.attesters.verifyRoom({ room_id: f.binding.room_id, mode: 'sandbox' }), 'CONCIERGE_BINDING_EXPIRED');
  assert.equal(f.calls.length, 0);
});

test('profile and room availability never replace host/boundary runtime proof or unused history', async t => {
  const f = setup(t);
  f.state.readiness.credential_boundary_verified = false;
  await rejects(f.attesters.verifyRoom({ room_id: f.binding.room_id, mode: 'sandbox' }), 'RUNTIME_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
  f.state.readiness.credential_boundary_verified = true;
  assert.equal((await f.attesters.verifyRoom({ room_id: f.binding.room_id, mode: 'sandbox' })).unused, true);
  source(f, 'Prior buyer message remains after they leave');
  assert.equal((await f.attesters.verifyRoom({ room_id: f.binding.room_id, mode: 'sandbox' })).unused, false);
  f.state.readiness.host_lead_ready = false;
  await rejects(f.attesters.verifyRoom({ room_id: f.binding.room_id, mode: 'sandbox' }), 'RUNTIME_UNAVAILABLE');
});

test('send success requires canonical owner, exact Host agent and exact text, not receipt shape', async t => {
  for (const mutate of [
    event => { event.sender = 'other_owner'; },
    event => { event.agent = { id: 'other_agent' }; },
    event => { event.message = 'Different payload'; },
  ]) {
    const f = setup(t); f.admitBuyer(); f.state.onSend = mutate;
    const message = { room_id: f.binding.room_id, source_event_id: source(f).id, delivery_key: 'synthetic_delivery', text: 'Host: saved scope' };
    await rejects(f.attesters.sendHost(message), 'CANONICAL_REPLY_MISMATCH');
    await rejects(f.attesters.sendHost(message), 'CANONICAL_REPLY_MISMATCH');
    assert.equal(sends(f), 1); // Same native cached receipt may be re-read, never another send.
  }
});

test('unknown native send is held with no blind replay and changed payload cannot reuse its key', async t => {
  const f = setup(t); f.admitBuyer(); f.state.failAfterSend = true;
  const message = { room_id: f.binding.room_id, source_event_id: source(f).id, delivery_key: 'synthetic_delivery', text: 'Host: scope saved' };
  await rejects(f.attesters.sendHost(message), 'SEND_RECONCILIATION_REQUIRED');
  await rejects(f.attesters.sendHost(message), 'SEND_RECONCILIATION_REQUIRED');
  await rejects(f.attesters.sendHost({ ...message, text: 'Changed reply' }), 'SEND_CONFLICT');
  assert.equal(sends(f), 1);
});

test('an old canonical receipt cannot acknowledge a later buyer source', async t => {
  const f = setup(t); f.admitBuyer();
  const message = { room_id: f.binding.room_id, source_event_id: source(f).id, delivery_key: 'synthetic_delivery', text: 'Host: saved' };
  const receipt = await f.attesters.sendHost(message);
  assert.ok(receipt.position > f.events.find(event => event.id === message.source_event_id).position);
  const next = source(f, 'A later distinct request');
  await rejects(f.attesters.sendHost({ ...message, source_event_id: next.id }), 'CANONICAL_REPLY_MISMATCH');
  assert.equal(sends(f), 1);
});
