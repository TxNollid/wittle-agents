import { SandboxClient } from '@solarisdk/sandbox';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const directory = resolve(root, '.solari');
const statePath = resolve(directory, 'agent.json');
const baseUrl = 'https://api.getsolari.com';
const apiKey = process.env.SOLARI_API_KEY;
if (!apiKey) throw new Error('Add SOLARI_API_KEY to the project root .env first.');
const client = new SandboxClient({ apiKey, baseUrl });
const command = process.argv[2] || 'status';

async function api(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Solari ${method} ${path} returned HTTP ${response.status}. Check your key, credits, and console.`);
  return response.status === 204 ? {} : response.json();
}
async function load() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('No deployment saved. Run npm run deploy first.'); throw error; }
}
async function save(state) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
async function invoke(state, path, body, token = state.agentToken) {
  const tunnel = await api(`/sandboxes/${encodeURIComponent(state.sandboxId)}/tunnel`);
  const url = tunnel.urlTemplate.replace('{port}', '3000');
  // Refresh Solari's one-hour token on every call; never log bearer URLs.
  for (let attempt = 0; attempt < 15; attempt++) {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-solari-preview-token': tunnel.authToken, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(150_000),
    });
    if ([425, 502, 503].includes(response.status) && body === undefined && attempt < 14) {
      await new Promise(resolve => setTimeout(resolve, 1000)); continue;
    }
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); }
    catch { throw new Error(`Agent gateway returned HTTP ${response.status} with a non-JSON response. Try npm run resume, then npm run health.`); }
    if (!response.ok) throw new Error(`Agent HTTP ${response.status}: ${result.error || 'request failed'}`);
    return result;
  }
}

if (command === 'deploy') {
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state?.executionId) throw new Error('Deployment already recorded. Use status, health, smoke, run, or resume.');
  const agentToken = state?.agentToken ?? randomBytes(32).toString('hex');
  const envs = { AGENT_TOKEN: agentToken, PORT: '3000', AGENT_AUDIENCE: process.env.AGENT_AUDIENCE || 'trusted-development' };
  for (const key of ['MODEL_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL']) if (process.env[key]) envs[key] = process.env[key];
  if (state) {
    const view = await client.get(state.sandboxId);
    if (view.state === 'paused' || view.state === 'parked') await api(`/sandboxes/${encodeURIComponent(state.sandboxId)}/resume`, 'POST', {});
    if (view.state === 'stopped') await api(`/sandboxes/${encodeURIComponent(state.sandboxId)}/start`, 'POST', {});
  }
  const sandbox = state ? await client.connect(state.sandboxId) : await client.create({
    template: 'base', cpu: 1, memMb: 2048, timeoutMs: 60 * 60_000,
    lifecycle: { onTimeout: 'kill' }, envs,
    metadata: { project: 'TeracHackathon', service: 'starter-agent' },
  });
  state ??= { sandboxId: sandbox.id, agentToken, createdAt: new Date().toISOString() };
  await save(state); // Persist immediately so even a failed setup is recoverable.
  console.log('Using project sandbox; connection details saved privately in .solari/agent.json.');
  try {
    await sandbox.connect();
    const version = await sandbox.commands.run('node', { args: ['--version'] });
    if (version.exitCode !== 0 || Number(version.stdout.trim().replace(/^v/, '').split('.')[0]) < 20) throw new Error('The remote template needs Node 20+; choose a compatible Solari template.');
    console.log(`Remote runtime: ${version.stdout.trim()}`);
    await sandbox.files.write('/work/agent.mjs', await readFile(new URL('./server.mjs', import.meta.url), 'utf8'));
    await sandbox.commands.run('mkdir',{args:['-p','/work/instructions']});
    await sandbox.files.write('/work/execution-policy.mjs',await readFile(new URL('./execution-policy.mjs',import.meta.url),'utf8'));
    await sandbox.files.write('/work/sessions.mjs',await readFile(new URL('./sessions.mjs',import.meta.url),'utf8'));
    await sandbox.files.write('/work/instructions/AGENTS.md',await readFile(new URL('./instructions/AGENTS.md',import.meta.url),'utf8'));
    // Gateway-owned execution survives this local deployment process disconnecting.
    const execution = await api(`/sandboxes/${encodeURIComponent(sandbox.id)}/executions`, 'POST', { cmd: 'node', args: ['/work/agent.mjs'], cwd: '/work', env: envs });
    state.executionId = execution.executionId;
    await save(state);
    await api(`/sandboxes/${encodeURIComponent(sandbox.id)}/tunnel`, 'POST', { authMode: 'authenticated', wakeOnHttp: true });
    console.log(JSON.stringify(await invoke(state, '/health'), null, 2));
    console.log(JSON.stringify(await invoke(state, '/smoke', {}), null, 2));
  } catch (error) {
    try { await sandbox.pause(); } catch { /* Saved sandbox ID permits recovery in the console. */ }
    throw error;
  } finally { sandbox.close(); }
} else {
  const state = await load();
  const path = `/sandboxes/${encodeURIComponent(state.sandboxId)}`;
  if (command === 'status') {
    const status = await client.get(state.sandboxId);
    console.log(JSON.stringify({ state: status.state, executionConfigured: Boolean(state.executionId), createdAt: state.createdAt }, null, 2));
  } else if (command === 'codex-install') {
    const result = await api(`${path}/exec`, 'POST', { cmd: 'mkdir', args: ['-p', '/work/codex-home', '/work/agent-workspace'] });
    if (result.exitCode !== 0) throw new Error('Could not create Codex directories.');
    const execution = await api(`${path}/executions`, 'POST', { cmd: 'npm', args: ['install', '--prefix', '/work/codex', '@openai/codex@0.164.0'], cwd: '/work' });
    state.codexInstallExecutionId = execution.executionId;
    await save(state);
    console.log('Codex install started. Run npm run codex-status to inspect progress.');
  } else if (command === 'codex-login') {
    const execution = await api(`${path}/executions`, 'POST', { cmd: '/work/codex/node_modules/.bin/codex', args: ['login', '--device-auth'], cwd: '/work', env: { CODEX_HOME: '/work/codex-home' } });
    state.codexLoginExecutionId = execution.executionId;
    await save(state);
    console.log('Device login started. Run npm run codex-status to get the sign-in link and code.');
  } else if (command === 'codex-status') {
    for (const field of ['codexInstallExecutionId', 'codexLoginExecutionId']) {
      if (!state[field]) continue;
      const result = await api(`${path}/executions/${encodeURIComponent(state[field])}`);
      const showOutput = field === 'codexInstallExecutionId' || result.status === 'running' || result.exitCode !== 0;
      console.log(JSON.stringify({ operation: field, status: result.status, exitCode: result.exitCode, ...(showOutput ? { stdout: result.stdout, stderr: result.stderr } : {}) }, null, 2));
    }
    const sandbox = await client.connect(state.sandboxId);
    try {
      await sandbox.connect();
      const result = await sandbox.commands.run('/work/codex/node_modules/.bin/codex', { args: ['login', 'status'], cwd: '/work', env: { CODEX_HOME: '/work/codex-home' } });
      console.log(JSON.stringify({ loginExitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, null, 2));
    } finally { sandbox.close(); }
  } else if (command === 'instructions') {
    const sandbox=await client.connect(state.sandboxId);
    try {
      await sandbox.connect();
      await sandbox.files.write('/work/instructions/AGENTS.md',await readFile(new URL('./instructions/AGENTS.md',import.meta.url),'utf8'));
      console.log('Instructions uploaded. Every new API or Rooms turn reloads this file; no restart is needed.');
    } finally {sandbox.close();}
  } else if (command === 'session-new') {
    const session=await invoke(state,'/sessions',{label:process.argv.slice(3).join(' ')});
    const directory=resolve(root,'.solari/sessions');await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(resolve(directory,`${session.id}.json`),JSON.stringify(session,null,2)+'\n',{mode:0o600});
    console.log(`Session ${session.id} created. Private client token saved in .solari/sessions/${session.id}.json.`);
  } else if (command === 'session-run') {
    const id=process.argv[3];if(!/^[a-f0-9-]{36}$/.test(id || ''))throw Error('Supply a session UUID, then the task.');
    const session=JSON.parse(await readFile(resolve(root,`.solari/sessions/${id}.json`),'utf8'));
    console.log(JSON.stringify(await invoke(state,`/sessions/${id}/run`,{task:process.argv.slice(4).join(' ')},session.token),null,2));
  } else if (command === 'configure-codex') {
    const sandbox = await client.connect(state.sandboxId);
    try {
      await sandbox.connect();
      await sandbox.files.write('/work/agent.mjs', await readFile(new URL('./server.mjs', import.meta.url), 'utf8'));
      await sandbox.files.write('/work/server.mjs',await readFile(new URL('./server.mjs',import.meta.url),'utf8'));
      await sandbox.files.write('/work/execution-policy.mjs',await readFile(new URL('./execution-policy.mjs',import.meta.url),'utf8'));
      await sandbox.files.write('/work/sessions.mjs',await readFile(new URL('./sessions.mjs',import.meta.url),'utf8'));
      await sandbox.commands.run('mkdir',{args:['-p','/work/instructions']});
      await sandbox.files.write('/work/instructions/AGENTS.md',await readFile(new URL('./instructions/AGENTS.md',import.meta.url),'utf8'));
      const stop = await sandbox.commands.run('node', { args: ['-e', `
        const fs = require('fs');
        for (const pid of fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p))) {
          try { const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0');
            if (args[0] === 'node' && args[1] === '/work/agent.mjs') process.kill(Number(pid), 'SIGTERM');
          } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(e.code)) throw e; }
        }
      `] });
      if (stop.exitCode !== 0) throw new Error('Could not stop the previous starter process.');
      const env = { AGENT_AUDIENCE: process.env.AGENT_AUDIENCE || 'trusted-development', AGENT_TOKEN: state.agentToken, PORT: '3000', MODEL_PROVIDER: 'codex', CODEX_HOME: '/work/codex-home', CODEX_BIN: '/work/codex/node_modules/.bin/codex', CODEX_WORKSPACE: '/work/agent-workspace',MAX_CONCURRENT_RUNS:process.env.MAX_CONCURRENT_RUNS || '2' };
      const execution = await api(`${path}/executions`, 'POST', { cmd: 'node', args: ['/work/agent.mjs'], cwd: '/work', env });
      state.executionId = execution.executionId;
      state.provider = 'codex';
      await save(state);
      console.log(JSON.stringify(await invoke(state, '/health'), null, 2));
    } finally { sandbox.close(); }
  } else if (command === 'pause' || command === 'resume') {
    await api(`${path}/${command}`, 'POST', {});
    console.log(`Sandbox ${command} requested.`);
  } else if (command === 'health') console.log(JSON.stringify(await invoke(state, '/health'), null, 2));
  else if (command === 'smoke') console.log(JSON.stringify(await invoke(state, '/smoke', {}), null, 2));
  else if (command === 'run') {
    const task = process.argv.slice(3).join(' ') || 'Read the actual current UTC time using a tool and tell me what runtime you are running in.';
    console.log(JSON.stringify(await invoke(state, '/run', { task }), null, 2));
  } else throw new Error('Commands: deploy, status, health, smoke, run, pause, resume, codex-install, codex-login, codex-status, configure-codex');
}
