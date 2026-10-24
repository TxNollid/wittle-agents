import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sessions, installInstructions } from './sessions.mjs';
import { createServer } from './server.mjs';
import { roomMcp } from './room-mcp.mjs';

test('instruction refresh replaces a chat-created symlink without touching its target',async t=>{
  const root=await mkdtemp(join(tmpdir(),'instructions-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace');await mkdir(workspace);
  const other=join(root,'other-chat-private.txt');await writeFile(other,'must remain unchanged');
  await symlink(other,join(workspace,'AGENTS.md'));
  await installInstructions(root,workspace,'new instructions');
  assert.equal(await readFile(other,'utf8'),'must remain unchanged');assert.equal(await readFile(join(workspace,'AGENTS.md'),'utf8'),'new instructions');
});

test('sessions run in parallel, preserve separate histories, enforce tokens, and reload instructions', async t=>{
  const root=await mkdtemp(join(tmpdir(),'sessions-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const instructions=join(root,'AGENTS.md');await writeFile(instructions,'Instruction version one');
  const sessions=new Sessions({AGENT_AUDIENCE:'trusted-development',SESSION_STATE_DIR:join(root,'state'),SESSION_WORK_DIR:join(root,'work'),AGENT_INSTRUCTIONS_FILE:instructions,MAX_CONCURRENT_RUNS:2},async(store,id,workspace)=>{await mkdir(workspace,{recursive:true});return {workspace};});
  let active=0,peak=0;const seen=[];
  const server=createServer({AGENT_AUDIENCE:'trusted-development',AGENT_TOKEN:'admin'},fetch,{sessions,run:async(task,context)=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,40));
    seen.push({task,history:context.history,instructions:context.instructions,workspace:context.workspace});active--;
    return {output:`answer:${task}`};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const create=async()=>{const r=await fetch(`${base}/sessions`,{method:'POST',headers:{Authorization:'Bearer admin'}});assert.equal(r.status,201);return r.json();};
  const a=await create(),b=await create();
  const call=(session,task,token=session.token)=>fetch(`${base}/sessions/${session.id}/run`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({task})});
  assert.equal((await call(a,'leak',b.token)).status,401);
  assert.equal((await fetch(`${base}/sessions`,{method:'POST',headers:{Authorization:`Bearer ${a.token}`}})).status,401);
  const results=await Promise.all([call(a,'ALPHA_PRIVATE'),call(b,'BETA_PRIVATE')]);assert.deepEqual(results.map(r=>r.status),[200,200]);assert.equal(peak,2);
  assert.equal(seen[0].history.length,0);assert.equal(seen[1].history.length,0);assert.notEqual(seen[0].workspace,seen[1].workspace);
  await writeFile(instructions,'Instruction version two');
  await Promise.all([call(a,'follow-a'),call(a,'follow-a-again')]);
  const follow=seen.find(s=>s.task==='follow-a');assert.equal(follow.history[0].content,'ALPHA_PRIVATE');assert.ok(!JSON.stringify(follow.history).includes('BETA_PRIVATE'));assert.equal(follow.instructions,'Instruction version two');
  const turns=seen.filter(s=>s.task.startsWith('follow-a'));assert.deepEqual(turns.map(s=>s.history.length),[2,4]);assert.equal(turns[1].history.at(-2).content,turns[0].task);
});

test('room-scoped MCP cannot read or send to another room or change account access',async t=>{
  let forwarded=0;
  const proxy=await roomMcp('room-a','upstream-secret',async(url,options)=>{forwarded++;assert.equal(options.headers.Authorization,'Bearer upstream-secret');return Response.json({jsonrpc:'2.0',id:1,result:{content:[]}});});
  t.after(()=>proxy.close());
  const call=(name,args,token=proxy.token)=>fetch(proxy.url,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  assert.equal((await call('read_room',{room_id:'room-a',action:'get'},'wrong')).status,401);
  assert.ok((await (await call('read_room',{room_id:'room-b',action:'events'})).json()).error);
  assert.ok((await (await call('agents',{action:'update'})).json()).error);
  assert.ok((await (await call('room',{room_id:'room-a',action:'add_member'})).json()).error);
  assert.equal(forwarded,0);
  assert.ok((await (await call('read_room',{room_id:'room-a',action:'events'})).json()).result);assert.equal(forwarded,1);
});
