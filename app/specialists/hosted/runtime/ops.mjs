// Owner-side operations for the HostedAgents fleet, using each agent's short-lived relay token.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const R = (process.env.ROOMS_RELAY_PACKAGE || join(homedir(), '.wittle-rooms/cli/lib/node_modules/@wittlelabs/rooms-relay'));
const { mcp, request } = await import(`${R}/core.mjs`);
const { createAuth } = await import(`${R}/auth.mjs`);
const server = 'https://rooms.wittlelabs.ai';
const home = join(homedir(), '.wittle-rooms', 'hostedagents', 'relay');
const auth = createAuth({ server, dir: home, clientId: 'client_01M5NX7KDR46Y1ZBP8J6054HQ5' });
const agents = JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8'));
export async function asAgent(name, tool, args) {
  const a = agents.find((x) => x.name === name);
  const data = await request(server, '/relay/agents', { name }, await auth.ownerToken());
  if (data.agent_id !== a.agent_id) throw new Error('agent id mismatch');
  return mcp(server, data.token, tool, args);
}
const [, , cmd, ...rest] = import.meta.url.endsWith("ops.mjs") && process.argv[1]?.endsWith("ops.mjs") ? process.argv : [];
if (cmd === 'public') {
  for (const a of agents) {
    const r = await asAgent(a.name, 'agents', { action: 'update', agent_id: a.agent_id, visibility: 'public', owner_approved: true });
    console.log(a.name, r.visibility, r.id);
  }
} else if (cmd === 'call') {
  const [name, tool, json] = rest;
  console.log(JSON.stringify(await asAgent(name, tool, JSON.parse(json || '{}')), null, 1).slice(0, process.env.FULL ? undefined : 3000));
}
