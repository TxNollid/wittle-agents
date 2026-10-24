// Actual transport/attester/integration/SQLite factories; EVERY provider/model observation is SYNTHETIC.
// No real client, auth file, key, gateway ledger, wake queue or network call is opened here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conciergeFixture } from './concierge-fixtures.mjs';
import { createHostProposer } from './host-proposal.mjs';
import { createFreeScopingIntegration } from '../integration/index.mjs';
import { validateJoinResponse } from '../web/lib/entry.mjs';
import { validateWire } from '../whop-payments/v2.mjs';

const sources = ['concierge-attesters.mjs', 'concierge-fixtures.mjs', 'index.mjs', 'host-proposal.mjs',
  '../solari-agent/concierge-rooms-transport.mjs', '../integration/index.mjs', '../integration/host.mjs',
  '../whop-payments/v2.mjs', '../contracts/v2.schema.json'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path,
  createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex')])));
const before = await hashes();
const directory = await mkdtemp(join(tmpdir(), 'concierge-consumer-smoke-'));
const f = conciergeFixture();
let app, generations = 0;
const completed = { site_url: 'https://example.com/', pages: ['https://example.com/'], excluded_pages: [],
  goal: 'Synthetic clarity review', constraints: ['Fixture only; no browsing or purchase'],
  scope_summary: 'Synthetic narrow public-page review', findings_cap: 3 };
const parent = { async generate({ messages }) {
  generations++;
  assert.equal(JSON.stringify(messages).includes(f.state.authority), false);
  const context = JSON.parse(messages[1].content);
  return { output: JSON.stringify({ role: 'host', reply: 'Synthetic saved draft; please review.',
    brief_update: context.event.text.includes('https://example.com/') ? completed : {}, tool_call: null, pause_reason: null }) };
} };
try {
  const prompt = (await Promise.all(['shared.md', 'host.md'].map(name => readFile(new URL(`../host-prompts/${name}`, import.meta.url), 'utf8')))).join('\n\n');
  const propose = createHostProposer(parent, { buyer_id: f.binding.buyer_id, room_id: f.binding.room_id,
    mode: 'sandbox', prompt_version: 'host-v1', system_prompt: prompt });
  const ports = { ...f.attesters, readReadiness: f.readReadiness, proposeScope: propose,
    async verifyCapability(authority) { return authority === f.state.authority ? { buyer_id: f.binding.buyer_id,
      room_id: f.binding.room_id, revoked_at: null, expires_at: f.binding.expires_at } : null; },
    async resolveAuthority({ capability }) { return capability === f.state.authority ? capability : null; },
  };
  const open = () => createFreeScopingIntegration({ directory, mode: 'sandbox', ports,
    rooms: [{ room_id: f.binding.room_id, mode: 'sandbox', join_url: f.binding.join_url, expires_at: f.binding.expires_at }] });
  app = open();
  const entry = await app.entry.allocate('synthetic_browser', { request_id: 'synthetic_entry_request' });
  assert.equal(validateJoinResponse(entry, 'sandbox'), f.binding.join_url);
  assert.equal((await app.entry.readiness()).quoting_available, false);
  f.admitBuyer();
  function addSource(text) { return f.addEvent({ sender: f.binding.buyer_id, agent: { name: 'Synthetic browser display label' }, message: text }); }
  const input = event => ({ raw: Buffer.from(JSON.stringify({ room_id: f.binding.room_id, message_id: event.id, position: event.position })) });
  const first = addSource('Please scope https://example.com/');
  const draft = await app.receiveRoomEvent(input(first));
  assert.deepEqual(draft.brief, completed, JSON.stringify(draft));
  assert.equal(draft.scope_agreed, false);
  const member = await f.attesters.membership({ buyer_id: f.binding.buyer_id, room_id: f.binding.room_id });
  validateWire('Id', member.membership_id); // Schema consumer only: this issues no capability or paid authority.
  const reply = f.events.find(event => event.id === draft.message_id);
  assert.equal(reply.sender, f.binding.owner_id);
  assert.equal(reply.agent.id, f.binding.agent_id);
  assert.equal(reply.message, draft.reply);
  const agreed = await app.receiveRoomEvent(input(addSource('yes')));
  assert.equal(agreed.state, 'agreed'); assert.equal(agreed.scope_agreed, true); assert.equal(agreed.quote, null);
  await app.receiveRoomEvent(input(addSource('Keep this agreed draft saved')));
  assert.equal(generations, 2);
  const sends = () => f.calls.filter(call => call.name === 'room').length;
  assert.equal(sends(), 3);
  assert.deepEqual(await app.receiveRoomEvent(input(first)), draft);
  assert.equal(generations, 2); assert.equal(sends(), 3);
  await app.close(); app = open();
  const saved = await app.brief(f.state.authority);
  assert.deepEqual(saved.brief, completed); assert.equal(saved.scope_agreed, true);
  assert.equal(saved.replies_used, 3); assert.equal(saved.remaining, 9); assert.equal(saved.quote, null);
  await assert.rejects(app.receiveRoomEvent({ raw: Buffer.from(JSON.stringify({ room_id: f.binding.room_id,
    message_id: first.id, buyer_id: f.binding.buyer_id, authority: f.state.authority })) }), error => error.code === 'INVALID_SOURCE_REFERENCE');
  f.state.afterAuthority = () => { f.room.members = f.room.members.filter(member => member.id !== f.binding.buyer_id); };
  await assert.rejects(app.receiveRoomEvent(input(addSource('Do not infer membership from this source'))), error => error.code === 'BUYER_NOT_CURRENT_MEMBER');
  assert.equal(generations, 2); assert.equal(sends(), 3);
  assert.deepEqual(await hashes(), before);
  console.log(JSON.stringify({ evidence_level: 'local_execution', synthetic_protocol_fixture: true,
    actual_provider_requests: 0, actual_rooms_calls: 0, actual_payment_calls: 0, actual_model_calls: 0,
    synthetic_generations: generations, simulated_same_room_messages: sends(),
    checks: { free_entry_without_quote: 'PASS', canonical_source_and_reply_identity: 'PASS',
      free_agreement_without_paid_feasibility: 'PASS', replay_no_extra_effect: 'PASS',
      agreement_and_quota_survive_host_reopen: 'PASS', forgery_and_revocation_before_effect: 'PASS',
      frozen_membership_id_wire_contract: 'PASS' },
    real_concierge_or_browser_acceptance: false, source_sha256: before }, null, 2));
} finally {
  if (app) await app.close();
  f.close(); await rm(directory, { recursive: true, force: true });
}
