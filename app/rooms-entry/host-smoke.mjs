// Actual parent gateway + integration host + SQLite, using ONLY injected synthetic provider/membership/send ports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOpenRouterParent } from '../solari-agent/openrouter-parent.mjs';
import { createHost } from '../integration/host.mjs';
import { createHostProposer } from './host-proposal.mjs';

const files = ['host-proposal.mjs', '../integration/host.mjs', '../solari-agent/openrouter-parent.mjs'];
const hashes = () => Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]));
const before = hashes();
const root = await mkdtemp(join(tmpdir(), 'free-host-smoke-'));
const keyPath = join(root, 'synthetic-key');
const syntheticKey = 'sk-or-v1-SYNTHETIC_HOST_SMOKE_NOT_A_REAL_PROVIDER_KEY';
const privateCanary = 'SYNTHETIC_PRIVATE_CONFIG_NOT_FOR_MODEL';
const now = () => Date.parse('2026-10-24T18:00:00.000Z');
let db, parent, generations = 0, sends = 0;
const positions = new Map();
const buyers = new Map([['fixture_room_a', 'fixture_buyer_a'], ['fixture_room_b', 'fixture_buyer_b']]);
try {
  await writeFile(keyPath, syntheticKey, { mode: 0o600 });
  const request = async (url, options) => {
    if (url === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { limit: 10, limit_reset: null, limit_remaining: 10, usage: 0 } });
    if (url === 'https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints') return Response.json({ data: {
      id: 'deepseek/deepseek-v3.2', endpoints: [{ tag: 'deepinfra/fp4', status: 0, supports_tool_choice: { none: true }, supported_parameters: ['max_tokens', 'tool_choice'], pricing: { prompt: '0.00000026', completion: '0.00000038', request: '0' } }],
    } });
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.ok(!options.body.includes(syntheticKey)); assert.ok(!options.body.includes(privateCanary));
    const body = JSON.parse(options.body), context = JSON.parse(body.messages.at(-1).content);
    assert.equal(body.tool_choice, 'none'); assert.equal(body.tools, undefined);
    assert.equal(context.mode, 'fixture'); assert.equal(context.buyer_id, buyers.get(context.room_id));
    generations++;
    const brief_update = context.saved_brief.site_url ? { goal: 'Mobile clarity' } : {
      site_url: 'https://fixture.example/', pages: ['https://fixture.example/'], excluded_pages: [],
      goal: 'Clarity', constraints: [], scope_summary: 'Fixture homepage audit', findings_cap: 10,
    };
    const proposal = { role: 'host', reply: `Fixture host for ${context.room_id}: your free brief is saved.`, brief_update, tool_call: null, pause_reason: null };
    return Response.json({ model: 'deepseek/deepseek-v3.2', provider: 'DeepInfra', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } }], usage: { cost: 0.00001, prompt_tokens: 100, completion_tokens: 100 } });
  };
  parent = await createOpenRouterParent({ dbPath: join(root, 'synthetic-parent.sqlite'), keyPath, request });
  const system_prompt = readFileSync(new URL('../host-prompts/shared.md', import.meta.url), 'utf8') + '\n\n' + readFileSync(new URL('../host-prompts/host.md', import.meta.url), 'utf8');
  const proposers = new Map([...buyers].map(([room_id, buyer_id]) => [room_id, createHostProposer(parent, {
    buyer_id, room_id, mode: 'fixture', prompt_version: 'scoping-v1_host-v1', system_prompt,
  })]));
  const dbPath = join(root, 'host.sqlite');
  const makeHost = () => createHost({ db, mode: 'fixture', now,
    propose: state => proposers.get(state.room_id)({ ...state, credentials: privateCanary, quote: { private: privateCanary },
      brief: { ...state.brief, operator_token: privateCanary }, event: { ...state.event, private_context: privateCanary } }),
    authorize: async event => { assert.equal(event.buyer_id, buyers.get(event.room_id)); },
    feasible: async () => { throw new Error('Paid feasibility is intentionally unavailable in this free draft smoke'); },
    issueQuote: async () => { throw new Error('No checkout allowed in this free draft smoke'); },
    orderStatus: async () => { throw new Error('No order operation allowed'); },
    send: async input => { sends++; const position = (positions.get(input.room_id) || 0) + 1; positions.set(input.room_id, position);
      return { room_id: input.room_id, delivery_key: input.delivery_key, message_id: `fixture_reply_${sends}`, position }; },
  });
  db = new DatabaseSync(dbPath);
  let host = makeHost();
  const event = (suffix, position, id = `fixture_host_event_${suffix}`) => ({ id, room_id: `fixture_room_${suffix}`, buyer_id: `fixture_buyer_${suffix}`, kind: 'message', position, text: 'Please discuss the scope of my public homepage audit for free.' });
  const handle = input => { positions.set(input.room_id, Math.max(positions.get(input.room_id) || 0, input.position)); return host.handle(input); };
  const [a, b] = await Promise.all([handle(event('a', 1)), handle(event('b', 1))]);
  assert.ok(a.reply.includes('fixture_room_a') && !a.reply.includes('fixture_room_b'));
  assert.ok(b.reply.includes('fixture_room_b') && !b.reply.includes('fixture_room_a'));
  assert.equal(host.inspect('fixture_room_a').brief.goal, 'Clarity');
  const beforeReplay = { generations, sends };
  await handle(event('a', 1));
  assert.deepEqual({ generations, sends }, beforeReplay);
  db.close(); db = new DatabaseSync(dbPath); host = makeHost();
  assert.equal(host.inspect('fixture_room_a').brief.goal, 'Clarity');
  assert.equal(host.inspect('fixture_room_a').replies_used, 1);

  // The supervisor reserves the last allowed reply BEFORE inference; remaining=0 must not erase turn12.
  db.prepare('UPDATE integration_briefs SET replies_used=11 WHERE room_id=?').run('fixture_room_a');
  await handle(event('a', 3, 'fixture_host_last_turn'));
  assert.equal(host.inspect('fixture_room_a').brief.goal, 'Mobile clarity');
  assert.equal(host.inspect('fixture_room_a').replies_used, 12);
  const beforePause = generations;
  const paused = await handle(event('a', 5, 'fixture_host_after_quota'));
  assert.equal(paused.state, 'paused'); assert.equal(paused.paused, 'quota_exhausted');
  assert.equal(generations, beforePause);
  assert.deepEqual(hashes(), before, 'Source candidate changed during smoke');
  console.log(JSON.stringify({ evidence_level: 'local_execution', mode: 'fixture', actual_provider_requests: 0, actual_rooms_calls: 0,
    checks: { first_reply_and_saved_draft: 'PASS', separate_room_contexts: 'PASS', duplicate_source_no_extra_effect: 'PASS',
      draft_and_quota_survive_reopen: 'PASS', last_reserved_reply_then_deterministic_pause: 'PASS', private_context_not_serialized: 'PASS' },
    synthetic_generations: generations, paid_or_agreed_scope_proved: false, runnable_browser_url: null, source_sha256: before,
  }, null, 2));
} finally {
  if (db) db.close(); if (parent) await parent.close(); await rm(root, { recursive: true, force: true });
}
