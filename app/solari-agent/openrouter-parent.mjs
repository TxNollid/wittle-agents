import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdir,chmod,lstat,open,readFile,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {readPrivateProviderKey} from './private-provider-key.mjs';

export const ROUTER_POLICY=Object.freeze({model:'deepseek/deepseek-v3.2',provider:'deepinfra/fp4',promptPerMillion:0.26,completionPerMillion:0.38,maxInputBytes:16000,maxPromptTokens:32768,maxOutputTokens:512,maxConcurrent:2,maxRequests:100,totalMicroUsd:10_000_000,reserveMicroUsd:100_000});
const fail=code=>Object.assign(new Error(code),{code,status:503});
const hash=value=>createHash('sha256').update(value).digest('hex');

// Private trusted-parent inference only. Never mount directly for browsers,
// expose its bearer, or pass caller-selected URLs/models/tools/options.
export async function createOpenRouterParent({dbPath,keyPath,request=fetch}) {
  const key=await readPrivateProviderKey(keyPath);
  await mkdir(dirname(dbPath),{recursive:true,mode:0o700});
  const dir=await lstat(dirname(dbPath));
  if(!dir.isDirectory() || dir.uid!==process.getuid() || (dir.mode&0o077))throw fail('PRIVATE_STATE_PERMISSIONS');
  try{const st=await lstat(dbPath);if(!st.isFile() || st.uid!==process.getuid() || (st.mode&0o077))throw fail('PRIVATE_STATE_PERMISSIONS');}catch(e){if(e.code!=='ENOENT')throw e;}
  const lockPath=`${dbPath}.lock`;
  let lease;
  for(let attempt=0;attempt<2;attempt++) {
    try {lease=await open(lockPath,'wx',0o600);await lease.writeFile(String(process.pid));break;}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const pid=Number(await readFile(lockPath,'utf8'));
      if(!Number.isSafeInteger(pid)||pid<=0)throw fail('SUPERVISOR_UNAVAILABLE');
      try{process.kill(pid,0);throw fail('SUPERVISOR_ALREADY_RUNNING');}
      catch(e){if(e.code!=='ESRCH')throw e;await unlink(lockPath);}
    }
  }
  if(!lease)throw fail('SUPERVISOR_UNAVAILABLE');
  const db=new DatabaseSync(dbPath);await chmod(dbPath,0o600);
  db.exec(`PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS parent_policy(id INTEGER PRIMARY KEY CHECK(id=1),key_hash TEXT NOT NULL,policy TEXT NOT NULL,baseline_micro INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS parent_inference_jobs(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,state TEXT NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS parent_requests(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,state TEXT NOT NULL,reserved_micro INTEGER NOT NULL,actual_micro INTEGER,output TEXT);`);
  db.exec("UPDATE parent_requests SET state='uncertain' WHERE state='reserved'");
  db.exec("UPDATE parent_inference_jobs SET state='needs_attention',error='UNKNOWN_OUTCOME' WHERE state='running'");
  const running=new Map();
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  let active=0;
  async function json(url,options={}) {
    const response=await request(url,{...options,redirect:'error',headers:{...options.headers,Authorization:`Bearer ${key}`},signal:options.signal || AbortSignal.timeout(10000)});
    if(!response.ok)throw fail('PROVIDER_UNAVAILABLE');
    return response.json();
  }
  async function verify(signal) {
    const [current,listing]=await Promise.all([
      json('https://openrouter.ai/api/v1/key',{signal}),
      json('https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2/endpoints',{signal}),
    ]);
    const data=current.data;
    if(!data || !Number.isFinite(data.limit) || data.limit<=0 || data.limit>10 || data.limit_reset!==null ||
       !Number.isFinite(data.usage) || data.usage<0 || !Number.isFinite(data.limit_remaining) || data.limit_remaining<0.1)throw fail('PROVIDER_KEY_CAP_UNVERIFIED');
    const endpoint=listing.data?.endpoints?.find(p=>p.tag===ROUTER_POLICY.provider);
    if(listing.data?.id!==ROUTER_POLICY.model || !endpoint || endpoint.status!==0 || endpoint.supports_tool_choice?.none!==true ||
       !endpoint.supported_parameters?.includes('max_tokens') || !endpoint.supported_parameters?.includes('tool_choice') ||
       !/^[0-9]+(?:\.[0-9]+)?$/.test(endpoint.pricing?.prompt || '') || Number(endpoint.pricing.request ?? 0)!==0 ||
       !Number.isFinite(Number(endpoint.pricing?.prompt)) || Number(endpoint.pricing.prompt)>0.00000026 || Number(endpoint.pricing.prompt)<0 ||
       !Number.isFinite(Number(endpoint.pricing?.completion)) || Number(endpoint.pricing.completion)>0.00000038 || Number(endpoint.pricing.completion)<0)throw fail('MODEL_POLICY_UNAVAILABLE');
    const observed=Math.ceil(data.usage*1_000_000);
    transaction(()=>{
      const saved=db.prepare('SELECT * FROM parent_policy WHERE id=1').get();
      if(saved && (saved.key_hash!==hash(key) || saved.policy!==JSON.stringify(ROUTER_POLICY)))throw fail('POLICY_CONFLICT');
      if(!saved)db.prepare('INSERT INTO parent_policy VALUES(1,?,?,?)').run(hash(key),JSON.stringify(ROUTER_POLICY),observed);
    });
    return observed;
  }
  function inspect() {
    return {...db.prepare('SELECT COUNT(*) AS requests,COALESCE(SUM(reserved_micro),0) AS reserved_micro,COALESCE(SUM(actual_micro),0) AS reported_actual_micro FROM parent_requests').get(),uncertain:db.prepare("SELECT COUNT(*) AS n FROM parent_requests WHERE state IN ('reserved','uncertain')").get().n,active,public_ready:false};
  }
  function validate(input) {
    if(!input || Object.keys(input).some(k=>!['request_id','messages'].includes(k)) || !/^[A-Za-z0-9_-]{8,100}$/.test(input.request_id || '') ||
       !Array.isArray(input.messages) || input.messages.length<1 || input.messages.length>12 ||
       input.messages.some(m=>!m || Object.keys(m).some(k=>!['role','content'].includes(k)) || !['system','user','assistant'].includes(m.role) || typeof m.content!=='string') ||
       Buffer.byteLength(JSON.stringify(input.messages))>ROUTER_POLICY.maxInputBytes)throw fail('INVALID_INPUT');
  }
  function assertLifecycle(id,payloadHash) {
    const job=db.prepare('SELECT payload_hash,state FROM parent_inference_jobs WHERE id=?').get(id);
    if(!job)return;
    if(job.payload_hash!==payloadHash)throw fail('CONFLICT');
    if(job.state==='cancelled')throw fail('CANCELLED');
    if(job.state==='needs_attention')throw fail('UNKNOWN_OUTCOME');
  }
  async function generate(input,{signal}={}) {
    validate(input);
    // Snapshot before awaits: caller mutation cannot change reserved content.
    const messages=structuredClone(input.messages),id=input.request_id,payloadHash=hash(JSON.stringify(messages));
    assertLifecycle(id,payloadHash);
    const saved=db.prepare('SELECT * FROM parent_requests WHERE id=?').get(id);
    if(saved){if(saved.payload_hash!==payloadHash)throw fail('CONFLICT');if(saved.state==='complete')return {output:saved.output,actual_micro:saved.actual_micro,replayed:true};throw fail('UNKNOWN_OUTCOME');}
    if(active>=ROUTER_POLICY.maxConcurrent)throw fail('CAPACITY_FULL');
    active++;
    let reserved=false;
    const deadline=AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]);
    try {
      const observed=await verify(deadline);
      deadline.throwIfAborted();
      transaction(()=>{
        assertLifecycle(id,payloadHash);
        if(db.prepare('SELECT 1 FROM parent_requests WHERE id=?').get(id))throw fail('DUPLICATE_IN_FLIGHT');
        // Any unknown prior response (including a previous-process crash) holds
        // its reservation and blocks new calls until operator reconciliation.
        const uncertain=db.prepare("SELECT COUNT(*) AS n FROM parent_requests WHERE state='uncertain'").get().n;
        const inFlight=db.prepare("SELECT COUNT(*) AS n FROM parent_requests WHERE state='reserved'").get().n;
        // A live local request owns a slot; leftover reserved rows from another
        // process are uncertain, never reclaimed on a timer.
        if(uncertain || inFlight>=2)throw fail('UNKNOWN_USAGE');
        const totals=inspect();
        const baseline=db.prepare('SELECT baseline_micro FROM parent_policy WHERE id=1').get().baseline_micro;
        if(totals.requests>=100 || Math.max(observed,baseline+totals.reserved_micro)+100_000>10_000_000)throw fail('BUDGET_EXHAUSTED');
        db.prepare("INSERT INTO parent_requests VALUES(?,?,'reserved',100000,NULL,NULL)").run(id,payloadHash);reserved=true;
      });
      const response=await json('https://openrouter.ai/api/v1/chat/completions',{
        method:'POST',signal:deadline,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:ROUTER_POLICY.model,messages,stream:false,max_tokens:512,tool_choice:'none',
          provider:{only:[ROUTER_POLICY.provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.26,completion:0.38,request:0}},reasoning:{enabled:false}}),
      });
      const choice=response.choices?.[0],message=choice?.message,usage=response.usage;
      const actual=Math.ceil(Number(usage?.cost)*1_000_000);
      if(response.model!==ROUTER_POLICY.model || response.provider!=='DeepInfra' || !Array.isArray(response.choices) || response.choices.length!==1 || choice.finish_reason!=='stop' ||
         !message || message.role!=='assistant' ||
         (Object.hasOwn(message,'tool_calls') && (!Array.isArray(message.tool_calls) || message.tool_calls.length!==0)) ||
         Object.hasOwn(message,'function_call') || typeof message.content!=='string' || !message.content.trim() || message.content.length>8000 ||
         !Number.isFinite(usage?.cost) || usage.cost<0 || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens<0 || usage.prompt_tokens>32768 ||
         !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens<0 || usage.completion_tokens>512 || actual>100_000)throw fail('UNVERIFIED_PROVIDER_RESULT');
      deadline.throwIfAborted();
      assertLifecycle(id,payloadHash);
      db.prepare("UPDATE parent_requests SET state='complete',actual_micro=?,output=? WHERE id=? AND state='reserved'").run(actual,message.content,id);
      return {output:message.content,actual_micro:actual,replayed:false};
    } catch(error) {
      if(reserved)db.prepare("UPDATE parent_requests SET state='uncertain' WHERE id=? AND state='reserved'").run(id);
      throw fail(['INVALID_INPUT','CONFLICT','CANCELLED','UNKNOWN_OUTCOME','CAPACITY_FULL','BUDGET_EXHAUSTED','MODEL_POLICY_UNAVAILABLE','PROVIDER_KEY_CAP_UNVERIFIED','POLICY_CONFLICT','UNKNOWN_USAGE','DUPLICATE_IN_FLIGHT','UNVERIFIED_PROVIDER_RESULT'].includes(error.code)?error.code:'PROVIDER_UNAVAILABLE');
    } finally {active--;}
  }
  function status(requestId) {
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId || ''))throw fail('INVALID_INPUT');
    const job=db.prepare('SELECT * FROM parent_inference_jobs WHERE id=?').get(requestId);
    return {request_id:requestId,state:job?.state || 'unknown',reason:job?.error || null,scope:'inference_only',public_ready:false};
  }
  function start(input) {
    validate(input);
    const snapshot=structuredClone(input),payloadHash=hash(JSON.stringify(snapshot.messages));
    const previous=db.prepare('SELECT * FROM parent_inference_jobs WHERE id=?').get(snapshot.request_id);
    if(previous){if(previous.payload_hash!==payloadHash)throw fail('CONFLICT');return status(snapshot.request_id);}
    if(active>=2)throw fail('CAPACITY_FULL');
    db.prepare("INSERT INTO parent_inference_jobs VALUES(?,?,'running',NULL)").run(snapshot.request_id,payloadHash);
    const controller=new AbortController();running.set(snapshot.request_id,controller);
    generate(snapshot,{signal:controller.signal}).then(()=>{
      db.prepare("UPDATE parent_inference_jobs SET state='result_ready' WHERE id=? AND state='running'").run(snapshot.request_id);
    },error=>{
      db.prepare("UPDATE parent_inference_jobs SET state='needs_attention',error=? WHERE id=? AND state='running'").run(error.code || 'UNKNOWN_OUTCOME',snapshot.request_id);
    }).finally(()=>running.delete(snapshot.request_id));
    return status(snapshot.request_id);
  }
  function cancel(requestId) {
    const current=status(requestId);
    if(['unknown','result_ready','cancelled'].includes(current.state))return current;
    const row=db.prepare('SELECT state FROM parent_requests WHERE id=?').get(requestId);
    // There is no provider cancellation receipt. Once a request may have been
    // sent, expose attention and retain its full reservation rather than claim
    // successful interruption. Abort prevents local result acceptance.
    const state=row ? 'needs_attention' : 'cancelled';
    db.prepare('UPDATE parent_inference_jobs SET state=?,error=? WHERE id=?').run(state,row?'CANCELLATION_UNCONFIRMED':null,requestId);
    running.get(requestId)?.abort();return status(requestId);
  }
  function result(requestId) {
    if(status(requestId).state!=='result_ready')throw fail('RESULT_UNAVAILABLE');
    const row=db.prepare("SELECT output,actual_micro FROM parent_requests WHERE id=? AND state='complete'").get(requestId);
    if(!row)throw fail('RESULT_UNAVAILABLE');
    return {request_id:requestId,output:row.output,actual_micro:row.actual_micro,scope:'inference_only'};
  }
  return Object.freeze({generate,start,status,cancel,result,verify:()=>verify(AbortSignal.timeout(10000)),inspect,close:async()=>{if(active || running.size)throw fail('BUSY');db.close();await lease.close();await unlink(lockPath);}});
}
