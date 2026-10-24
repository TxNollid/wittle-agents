import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostProposer } from './host-proposal.mjs';

const binding = { buyer_id: 'fixture_buyer', room_id: 'fixture_room', mode: 'fixture', prompt_version: 'scoping-v1_host-v1', system_prompt: 'Fixture free scoping policy.' };
const state = () => ({ buyer_id: binding.buyer_id, room_id: binding.room_id, paused: null, brief: {},
  scope_version: 0, scope_hash: 'a'.repeat(64), replies_used: 1, remaining: 11,
  event: { id: 'fixture_event_1', kind: 'message', position: 1, text: 'Please help scope my public website audit.' } });
const valid = () => ({ role: 'host', reply: 'What public URL and goal should we discuss?', brief_update: {}, tool_call: null, pause_reason: null });

// A browser/model-supplied context cannot switch the trusted binding or bypass an admitted turn.
test('cross-room/buyer, paused and unreserved turns are denied before inference', async () => {
  let calls = 0;
  const propose = createHostProposer({ generate: async () => { calls++; return { output: JSON.stringify(valid()) }; } }, binding);
  for (const patch of [{ room_id: 'other_room' }, { buyer_id: 'other_buyer' }, { paused: 'quota_exhausted' },
    { replies_used: 0, remaining: 12 }, { replies_used: 13, remaining: 0 }, { remaining: 12 },
    { event: { ...state().event, kind: 'scope_agreed' } }]) {
    await assert.rejects(propose({ ...state(), ...patch }), error => error.code === 'HOST_CONTEXT_DENIED');
  }
  assert.equal(calls, 0);
});

test('large context fails before a chargeable model request rather than truncating saved scope', async () => {
  let calls = 0;
  const propose = createHostProposer({ generate: async () => { calls++; } }, binding);
  const input = state(); input.brief.constraints = ['x'.repeat(17_000)];
  await assert.rejects(propose(input), error => error.code === 'HOST_CONTEXT_TOO_LARGE');
  assert.equal(calls, 0);
});

test('model operations, hidden fields and malformed proposal shapes never become host actions', async () => {
  for (const patch of [
    { tool_call: { operation: 'quote', arguments: { amount_minor: 1 } } },
    { tool_call: { operation: 'shell', arguments: { command: 'synthetic-do-not-run' } } },
    { role: 'operator' }, { buyer_id: 'forged_buyer' }, { hidden_reasoning: 'must not reach room' },
    { reply: { text: 'not plain text' } }, { brief_update: [] }, { pause_reason: 'paid' },
  ]) {
    let calls = 0;
    const propose = createHostProposer({ generate: async () => { calls++; return { output: JSON.stringify({ ...valid(), ...patch }) }; } }, binding);
    await assert.rejects(propose(state()), error => error.code === 'INVALID_HOST_PROPOSAL');
    assert.equal(calls, 1, 'Invalid output must not trigger a second inference request');
  }
});

test('invalid JSON and fenced/freeform fallbacks are rejected without retry', async () => {
  for (const output of ['not json', '```json\n{}\n```', '[]', 'null', JSON.stringify({ role: 'host', reply: 'incomplete' })]) {
    let calls = 0;
    const propose = createHostProposer({ generate: async () => { calls++; return { output }; } }, binding);
    await assert.rejects(propose(state()), error => error.code === 'INVALID_HOST_PROPOSAL');
    assert.equal(calls, 1);
  }
});

test('parent admission/capacity errors propagate without inventing a successful scoping reply', async () => {
  let calls = 0;
  const propose = createHostProposer({ generate: async () => { calls++; throw Object.assign(new Error('CAPACITY_FULL'), { code: 'CAPACITY_FULL' }); } }, binding);
  await assert.rejects(propose(state()), error => error.code === 'CAPACITY_FULL');
  assert.equal(calls, 1);
});
