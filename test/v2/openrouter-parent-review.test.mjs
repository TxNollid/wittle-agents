import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod, symlink, link, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenRouterParent } from "../../app/solari-agent/openrouter-parent.mjs";
import { readPrivateProviderKey } from "../../app/solari-agent/private-provider-key.mjs";
const files = ["openrouter-parent.mjs", "private-provider-key.mjs"];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(new URL(`../../app/solari-agent/${file}`, import.meta.url))).digest("hex")])));
const before = await hashes();
const input = request_id => ({ request_id, messages: [{ role: "user", content: "QA_SYNTHETIC_BRIEF" }] });
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "qa-router-"));
  await chmod(root, 0o700);
  const keyPath = join(root, "synthetic-key"), dbPath = join(root, "synthetic.sqlite");
  const key = "sk-or-v1-QA_SYNTHETIC_NOT_A_REAL_PROVIDER_KEY";
  await writeFile(keyPath, key, { mode: 0o600 });
  const state = { creates: 0, mutate: null };
  const request = async (url, options) => {
    if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: { limit: 10, limit_reset: null, limit_remaining: 10, usage: 0 } });
    if (url === "https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints") return Response.json({ data: { id: "deepseek/deepseek-v3.2", endpoints: [{ tag: "deepinfra/fp4", status: 0, supports_tool_choice: { none: true }, supported_parameters: ["max_tokens", "tool_choice"], pricing: { prompt: "0.00000026", completion: "0.00000038", request: "0" } }] } });
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions", "no unreviewed destination");
    state.creates++;
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, "none");
    assert.equal(options.body.includes(key), false);
    const result = { model: "deepseek/deepseek-v3.2", provider: "DeepInfra", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "QA_SYNTHETIC_RESULT" } }], usage: { cost: 0.00001, prompt_tokens: 10, completion_tokens: 10 } };
    if (state.mutate) state.mutate(result);
    return Response.json(result);
  };
  const parent = await createOpenRouterParent({ dbPath, keyPath, request });
  t.after(async () => { await new Promise(setImmediate); await parent.close(); await rm(root, { recursive: true, force: true }); });
  return { parent, root, keyPath, dbPath, request, state };
}

test("confirmed early cancellation also blocks synchronous generate replay of the same request", async t => {
  const f = await setup(t), value = input("qa_cancel_then_generate");
  assert.equal(f.parent.start(value).state, "running");
  assert.equal(f.parent.cancel(value.request_id).state, "cancelled");
  await new Promise(setImmediate);
  assert.equal(f.state.creates, 0);
  const outcome = await Promise.allSettled([f.parent.generate(value)]);
  console.log("QA_ROUTER_CANCEL_REPLAY " + JSON.stringify({ outcome: outcome[0].status, provider_create_calls: f.state.creates, status: f.parent.status(value.request_id).state }));
  assert.equal(outcome[0].status, "rejected", "generate must preserve the same request cancellation tombstone");
  assert.equal(f.state.creates, 0);
});

test("malformed tool-call objects are rejected and hold unknown provider outcome", async t => {
  const f = await setup(t);
  f.state.mutate = result => { result.choices[0].message.tool_calls = { function: { name: "read_file", arguments: "{}" } }; };
  const outcome = await Promise.allSettled([f.parent.generate(input("qa_malformed_tool_call"))]);
  console.log("QA_ROUTER_TOOL_SHAPE " + JSON.stringify({ outcome: outcome[0].status, uncertain: f.parent.inspect().uncertain }));
  assert.equal(outcome[0].status, "rejected", "non-array tool metadata must not silently pass no-tools validation");
  assert.equal(f.parent.inspect().uncertain, 1);
});

test("private synthetic key rejects symlink and hardlink aliases", async t => {
  const f = await setup(t), alias = join(f.root, "alias");
  await symlink(f.keyPath, alias);
  await assert.rejects(readPrivateProviderKey(alias), { code: "ELOOP" });
  await link(f.keyPath, join(f.root, "hardlink"));
  await assert.rejects(readPrivateProviderKey(f.keyPath), /PRIVATE_KEY_PERMISSIONS/);
});

test("a second live gateway cannot acquire the same private budget ledger", async t => {
  const f = await setup(t);
  await assert.rejects(createOpenRouterParent({ dbPath: f.dbPath, keyPath: f.keyPath, request: f.request }), { code: "SUPERVISOR_ALREADY_RUNNING" });
  assert.equal(f.state.creates, 0);
});

after(async () => { assert.deepEqual(await hashes(), before, "Candidate changed during independent gateway review"); console.log("QA_ROUTER_SHA256 " + JSON.stringify(before)); });
