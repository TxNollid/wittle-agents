import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, runAgent, runCodexAgent } from './server.mjs';
import { writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function testConfig(t) {
  const root=await mkdtemp(join(tmpdir(),'agent-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  return {AGENT_AUDIENCE:'trusted-development',SESSION_STATE_DIR:join(root,'state'),SESSION_WORK_DIR:join(root,'work')};
}

test('Codex task uses stdin and returns the final answer file, then cleans it up', async () => {
  let answerPath;
  const task = 'Read the current UTC time; literal $(do-not-run)';
  const result = await runCodexAgent(task, {AGENT_AUDIENCE:'trusted-development'}, async (args, config, input) => {
    assert.ok(args.includes('--sandbox'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.equal(args.at(-1), '-');
    assert.ok(!args.includes(task));
    assert.ok(input.endsWith(task));
    answerPath = args[args.indexOf('--output-last-message') + 1];
    await writeFile(answerPath, 'Verified from a tool.\n');
  });
  assert.equal(result.output, 'Verified from a tool.');
  assert.equal(result.trace[0].auth, 'chatgpt');
  await assert.rejects(access(answerPath));
});

test('OpenRouter receives its own key and model through the Responses API', async () => {
  const answer = await runAgent('hello', { AGENT_AUDIENCE:'trusted-development', OPENROUTER_API_KEY: 'router-test', OPENROUTER_MODEL: 'vendor/model', OPENAI_API_KEY: 'must-not-send' }, async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer router-test');
    assert.equal(JSON.parse(options.body).model, 'vendor/model');
    assert.equal(JSON.parse(options.body).store, false);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] });
  });
  assert.equal(answer.output, 'hello');
});

test('authenticated HTTP service and model-to-tool-to-model round trip', async t => {
  let calls = 0;
  const provider = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    if (++calls === 1) {
      assert.equal(body.input[0].content, 'What time is it?');
      return Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'get_current_time', call_id: 'time-1', arguments: '{}' }] });
    }
    const result = body.input.find(item => item.type === 'function_call_output');
    assert.equal(result.call_id, 'time-1');
    assert.ok(Number.isFinite(Date.parse(JSON.parse(result.output).utc)));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'The time tool worked.' }] }] });
  };
  const server = createServer({ ...await testConfig(t),AGENT_TOKEN: 'test-token', OPENAI_API_KEY: 'fake-key', OPENAI_MODEL: 'test-model' }, provider);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${origin}/health`)).status, 401);
    assert.equal((await (await fetch(`${origin}/health`, { headers })).json()).modelConfigured, true);
    const smoke = await fetch(`${origin}/smoke`, { method: 'POST', headers, body: '{}' });
    assert.equal((await smoke.json()).mode, 'infrastructure-smoke');
    const run = await fetch(`${origin}/run`, { method: 'POST', headers, body: JSON.stringify({ task: 'What time is it?' }) });
    assert.equal(run.status, 200);
    const value = await run.json();
    assert.equal(value.output, 'The time tool worked.');
    assert.equal(value.trace[0].tool, 'get_current_time');
    assert.equal(calls, 2);
    assert.equal((await fetch(`${origin}/run`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${origin}/run`, { method: 'POST', headers, body: '{' })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('smoke works without model credentials; model calls fail clearly', async t => {
  const server = createServer({ ...await testConfig(t),AGENT_TOKEN: 'test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test' };
  try {
    assert.equal((await fetch(`${origin}/smoke`, { method: 'POST', headers })).status, 200);
    const run = await fetch(`${origin}/run`, { method: 'POST', headers, body: JSON.stringify({ task: 'hi' }) });
    assert.equal(run.status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
