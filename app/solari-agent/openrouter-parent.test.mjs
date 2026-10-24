import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createOpenRouterParent} from './openrouter-parent.mjs';
import {readPrivateProviderKey} from './private-provider-key.mjs';

const key='sk-or-v1-SYNTHETIC_PRIVATE_KEY_CANARY_12345';
async function fixture(t,modify=()=>{}) {
  const root=await mkdtemp(join(tmpdir(),'router-parent-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
  const keyPath=join(root,'key');await writeFile(keyPath,key,{mode:0o600});
  const dbPath=join(root,'budget.sqlite');
  let calls=0;
  const request=async(url,options)=>{
    assert.equal(options.headers.Authorization,`Bearer ${key}`);
    if(url.endsWith('/key'))return Response.json({data:{limit:10,limit_reset:null,limit_remaining:10,usage:0}});
    if(url.endsWith('/endpoints'))return Response.json({data:{id:'deepseek/deepseek-v3.2',endpoints:[{tag:'deepinfra/fp4',status:0,supports_tool_choice:{none:true},supported_parameters:['max_tokens','tool_choice'],pricing:{prompt:'0.00000026',completion:'0.00000038'}}]}});
    calls++;
    const body=JSON.parse(options.body);assert.equal(body.model,'deepseek/deepseek-v3.2');assert.equal(body.tool_choice,'none');assert.equal(body.tools,undefined);assert.equal(body.plugins,undefined);assert.deepEqual(body.provider.only,['deepinfra/fp4']);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.max_tokens,512);assert.ok(!options.body.includes(key));
    const result={model:'deepseek/deepseek-v3.2',provider:'DeepInfra',choices:[{finish_reason:'stop',message:{role:'assistant',content:body.messages.at(-1).content}}],usage:{cost:0.00001,prompt_tokens:10,completion_tokens:10}};
    await modify(result,options);
    return Response.json(result);
  };
  const parent=await createOpenRouterParent({dbPath,keyPath,request});
  return {parent,dbPath,keyPath,request,calls:()=>calls};
}
const input=(id,content='synthetic brief')=>({request_id:id,messages:[{role:'user',content}]});

test('private loader refuses readable key; no provider credential in model body; replay and cap survive reopen',async t=>{
  const f=await fixture(t);await chmod(f.keyPath,0o644);await assert.rejects(readPrivateProviderKey(f.keyPath),/PRIVATE_KEY_PERMISSIONS/);await chmod(f.keyPath,0o600);
  const first=await f.parent.generate(input('request_0001'));assert.equal(first.output,'synthetic brief');
  assert.equal((await f.parent.generate(input('request_0001'))).replayed,true);assert.equal(f.calls(),1);
  await assert.rejects(f.parent.generate(input('request_0001','different')),e=>e.code==='CONFLICT');
  await f.parent.close();
  const reopened=await createOpenRouterParent({dbPath:f.dbPath,keyPath:f.keyPath,request:f.request});
  assert.equal(reopened.inspect().reserved_micro,100000);assert.equal((await reopened.generate(input('request_0001'))).replayed,true);
  await reopened.close();assert.equal(await readFile(f.keyPath,'utf8'),key);
});

test('unknown provider tool calls hold money and stop all new requests across restart',async t=>{
  const f=await fixture(t,result=>{result.choices[0].message.tool_calls=[{function:{name:'read_file',arguments:'{"path":"auth.json"}'}}];});
  await assert.rejects(f.parent.generate(input('unknown_0001')),e=>e.code==='UNVERIFIED_PROVIDER_RESULT');
  assert.equal(f.parent.inspect().reserved_micro,100000);assert.equal(f.parent.inspect().uncertain,1);
  await f.parent.close();
  const reopened=await createOpenRouterParent({dbPath:f.dbPath,keyPath:f.keyPath,request:f.request});
  await assert.rejects(reopened.generate(input('another_0001')),e=>e.code==='UNKNOWN_USAGE');
  assert.equal(f.calls(),1);await reopened.close();
});

test('two parallel contexts, third denied, reservation admission is cumulative and input cannot expand tools',async t=>{
  let release;const hold=new Promise(r=>release=r);
  const f=await fixture(t,()=>hold);
  const a=f.parent.generate(input('parallel_a1','ALPHA')),b=f.parent.generate(input('parallel_b1','BETA'));
  await assert.rejects(f.parent.generate(input('parallel_c1')),e=>e.code==='CAPACITY_FULL');
  release();const out=await Promise.all([a,b]);assert.deepEqual(out.map(r=>r.output),['ALPHA','BETA']);
  for(const extra of [{model:'other'},{tools:[{name:'shell'}]},{provider:{only:['other']}},{plugins:[{id:'web'}]}])await assert.rejects(f.parent.generate({...input('invalid_0001'),...extra}),e=>e.code==='INVALID_INPUT');
  await f.parent.close();
  const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE parent_policy SET baseline_micro=9900000 WHERE id=1').run();db.close();
  const reopened=await createOpenRouterParent({dbPath:f.dbPath,keyPath:f.keyPath,request:f.request});
  await assert.rejects(reopened.generate(input('budget_limit_1')),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(f.calls(),2);await reopened.close();
});

test('provider key with no nonresetting cap or price-policy violation cannot generate',async t=>{
  const f=await fixture(t);await f.parent.close();
  for(const bad of ['cap','price']) {
    const parent=await createOpenRouterParent({dbPath:f.dbPath,keyPath:f.keyPath,request:async(url,options)=>{
      if(bad==='cap'&&url.endsWith('/key'))return Response.json({data:{limit:null,limit_reset:null,limit_remaining:10,usage:0}});
      if(bad==='price'&&url.endsWith('/endpoints'))return Response.json({data:{id:'wrong-model',endpoints:[]}});
      return f.request(url,options);
    }});
    await assert.rejects(parent.generate(input(`blocked_${bad}_1`)),e=>['PROVIDER_KEY_CAP_UNVERIFIED','MODEL_POLICY_UNAVAILABLE'].includes(e.code));await parent.close();
  }
  assert.equal(f.calls(),0);
});

test('durable async start/status/result replay and cancellation report only proven local outcomes',async t=>{
  const f=await fixture(t);
  const data=input('queued_request_1');assert.equal(f.parent.start(data).state,'running');
  assert.equal(f.parent.start(data).state,'running');
  for(let i=0;i<100 && f.parent.status(data.request_id).state==='running';i++)await new Promise(r=>setTimeout(r,1));
  assert.equal(f.parent.status(data.request_id).state,'result_ready');assert.equal(f.parent.result(data.request_id).output,'synthetic brief');assert.equal(f.calls(),1);
  assert.equal(f.parent.cancel(data.request_id).state,'result_ready');
  const early=input('cancel_before_send');f.parent.start(early);assert.equal(f.parent.cancel(early.request_id).state,'cancelled');
  for(let i=0;i<100 && f.parent.inspect().active;i++)await new Promise(r=>setTimeout(r,1));
  assert.equal(f.calls(),1);await f.parent.close();
  const reopened=await createOpenRouterParent({dbPath:f.dbPath,keyPath:f.keyPath,request:f.request});
  assert.equal(reopened.start(data).state,'result_ready');assert.equal(reopened.result(data.request_id).output,'synthetic brief');await reopened.close();
});

test('cancel after possible send never claims provider interruption; crash holds deny replay',async t=>{
  let release;const hold=new Promise(r=>release=r);
  const f=await fixture(t,()=>hold);
  const data=input('late_cancel_001');f.parent.start(data);
  for(let i=0;i<100 && f.calls()===0;i++)await new Promise(r=>setTimeout(r,1));
  assert.equal(f.parent.cancel(data.request_id).state,'needs_attention');release();
  for(let i=0;i<100 && f.parent.inspect().active;i++)await new Promise(r=>setTimeout(r,1));
  assert.equal(f.parent.inspect().uncertain,1);assert.equal(f.parent.inspect().reserved_micro,100000);
  assert.throws(()=>f.parent.result(data.request_id),e=>e.code==='RESULT_UNAVAILABLE');await f.parent.close();
  const db=new DatabaseSync(f.dbPath);db.prepare("INSERT INTO parent_requests VALUES('crashed_request','hash','reserved',100000,NULL,NULL)").run();db.prepare("INSERT INTO parent_inference_jobs VALUES('crashed_request','hash','running',NULL)").run();db.close();
  const reopened=await createOpenRouterParent({dbPath:f.dbPath,keyPath:f.keyPath,request:f.request});
  assert.equal(reopened.status('crashed_request').state,'needs_attention');assert.equal(reopened.inspect().uncertain,2);
  await assert.rejects(reopened.generate(input('after_crash_001')),e=>e.code==='UNKNOWN_USAGE');assert.equal(f.calls(),1);await reopened.close();
});
