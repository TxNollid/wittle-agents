import { SandboxClient } from '@solarisdk/sandbox';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.loadEnvFile(resolve(root, '.env'));
const statePath = resolve(root, '.solari/agent.json');
const state = JSON.parse(await readFile(statePath, 'utf8'));
const client = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY, baseUrl: 'https://api.getsolari.com' });
const relay = '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/bin.mjs';
const node = '/work/rooms-runtime/node_modules/.bin/node';
const env = {
  AGENT_AUDIENCE:process.env.AGENT_AUDIENCE || 'trusted-development',
  TRUSTED_ROOM_IDS:process.env.TRUSTED_ROOM_IDS || '',
  PATH: '/work/rooms-runtime/node_modules/.bin:/work/codex/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  CODEX_HOME: '/work/codex-home', ROOMS_RELAY_HOME: '/work/rooms-relay', WITTLE_CODEX_BIN: '/work/rooms-codex.mjs',
  MAX_CONCURRENT_RUNS:process.env.MAX_CONCURRENT_RUNS || '2',
};
const base = `https://api.getsolari.com/sandboxes/${encodeURIComponent(state.sandboxId)}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${process.env.SOLARI_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Solari relay operation returned HTTP ${response.status}.`);
  return response.json();
}
async function save() { await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
async function run(args) {
  const sandbox = await client.connect(state.sandboxId);
  try {
    await sandbox.connect();
    const result = await sandbox.commands.run(node, { args: [relay, ...args], cwd: '/work', env });
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Relay command failed.');
    console.log(result.stdout);
    return result.stdout;
  } finally { sandbox.close(); }
}
const command = process.argv[2] || 'status';
if (command === 'status') await run(['status', ...(process.argv.includes('--wakes') ? ['--wakes'] : [])]);
else if (command === 'add') {
  const name = process.argv[3] || 'solari-hackathon';
  const sandbox = await client.connect(state.sandboxId);
  try {
    await sandbox.connect();
    const prepared = await sandbox.commands.run('node', { args: ['-e', `
      const fs = require('fs'); const cp = require('child_process');
      fs.mkdirSync('/work/agent-workspace', {recursive:true});
      if (!fs.existsSync('/work/agent-workspace/.git')) {
        const result = cp.spawnSync('git', ['init', '-b', 'main', '/work/agent-workspace']);
        if (result.status !== 0) process.exit(1);
      }
    `] });
    if (prepared.exitCode !== 0) throw new Error('Could not prepare the Git workspace required by the Codex fleet runner.');
  } finally { sandbox.close(); }
  const stdout = await run(['add', name, '--app', 'codex', '--dir', '/work/agent-workspace', '--sandbox', 'danger-full-access', '--role', 'Hosted hackathon agent', '--bio', 'Codex running in a dedicated Solari sandbox; wakes on authorized Rooms events while the VM and relay are running.']);
  const agent = JSON.parse(stdout);
  state.roomsAgentId = agent.agent_id;
  state.roomsAgentName = agent.name;
  await save();
} else if (command === 'start') {
  if (!env.TRUSTED_ROOM_IDS.trim()) throw new Error('Set TRUSTED_ROOM_IDS to the comma-separated private developer room IDs before starting the trusted relay. Buyer rooms must not be listed.');
  if (state.roomsRelayExecutionId) {
    const previous = await api(`/executions/${encodeURIComponent(state.roomsRelayExecutionId)}`);
    if (previous.status === 'running') throw new Error('The relay execution is already running.');
  }
  const sandbox = await client.connect(state.sandboxId);
  try {
    await sandbox.connect();
    await sandbox.files.write('/work/rooms-codex.mjs', await readFile(new URL('./rooms-codex.mjs', import.meta.url), 'utf8'));
    for(const file of ['rooms-parallel.mjs','sessions.mjs','room-mcp.mjs','server.mjs','execution-policy.mjs'])await sandbox.files.write(`/work/${file}`,await readFile(new URL(`./${file}`,import.meta.url),'utf8'));
    await sandbox.commands.run('mkdir',{args:['-p','/work/instructions']});
    await sandbox.files.write('/work/instructions/AGENTS.md',await readFile(new URL('./instructions/AGENTS.md',import.meta.url),'utf8'));
    const result = await sandbox.commands.run('chmod', { args: ['700', '/work/rooms-codex.mjs'] });
    if (result.exitCode !== 0) throw new Error('Could not prepare the Codex relay wrapper.');
  } finally { sandbox.close(); }
  const result = await api('/executions', 'POST', { cmd: node, args: ['/work/rooms-parallel.mjs'], cwd: '/work', env:{...env,MODEL_PROVIDER:'codex'} });
  state.roomsRelayExecutionId = result.executionId;
  await save();
  console.log('Rooms relay process started. Use rooms-status and rooms-wakes; a running process alone does not prove an agent wake.');
} else if (command === 'stop') await run(['stop']);
else if (command === 'login') {
  const sandbox = await client.connect(state.sandboxId);
  try { await sandbox.connect(); await sandbox.files.write('/work/rooms-auth.mjs', await readFile(new URL('./rooms-auth.mjs', import.meta.url), 'utf8')); }
  finally { sandbox.close(); }
  const result = await api('/executions', 'POST', { cmd: node, args: ['/work/rooms-auth.mjs'], cwd: '/work' });
  state.roomsAuthExecutionId = result.executionId;
  await save();
  for (let i = 0; i < 20; i++) {
    const result = await api(`/executions/${encodeURIComponent(state.roomsAuthExecutionId)}`);
    const line = (result.stdout || '').split('\n').find(line => line.startsWith('{"authorization_url"'));
    if (line) {
      const login = JSON.parse(line);
      const tunnel = await api('/tunnel');
      login.callback_origin = tunnel.urlTemplate.replace('{port}', '53683');
      login.tunnel_token = tunnel.authToken;
      await writeFile(resolve(root, '.solari/rooms-login.json'), JSON.stringify(login, null, 2) + '\n', { mode: 0o600 });
      console.log('Open this sign-in URL in your laptop browser:', login.authorization_url);
      await (await import('./rooms-callback.mjs')).startCallback();
      break;
    }
    if (result.status !== 'running') throw new Error(result.stderr || 'Rooms login ended before showing a URL.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} else throw new Error('Commands: status [--wakes], add [name], start, stop, login');
