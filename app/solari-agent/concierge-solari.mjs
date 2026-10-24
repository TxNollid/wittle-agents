// Operator-only provisioning/auth for a NEW restricted concierge sandbox.
// Never imports the legacy Codex runner or prints service/tunnel credentials.
import {SandboxClient} from '@solarisdk/sandbox';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCallbackServer} from './rooms-callback.mjs';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
process.loadEnvFile(resolve(root,'.env'));
const statePath=resolve(root,'.solari/concierge.json');
const client=new SandboxClient({apiKey:process.env.SOLARI_API_KEY,baseUrl:'https://api.getsolari.com'});
const command=process.argv[2] || 'status';
let state;
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
async function save(){await mkdir(resolve(root,'.solari'),{recursive:true,mode:0o700});await writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});}
async function api(path,method='GET',body){const r=await fetch(`https://api.getsolari.com/sandboxes/${encodeURIComponent(state.sandboxId)}${path}`,{method,headers:{Authorization:`Bearer ${process.env.SOLARI_API_KEY}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`SOLARI_HTTP_${r.status}`);return r.json();}
async function run(sandbox,cmd,args,env){const r=await sandbox.commands.run(cmd,{args,cwd:'/',...(env?{env}:{})});if(r.exitCode!==0)throw Error('CONCIERGE_PREP_COMMAND_FAILED');return r.stdout;}
const node='/work/concierge-runtime/node_modules/.bin/node';
async function authSource(){return (await readFile(new URL('./rooms-auth.mjs',import.meta.url),'utf8')).replaceAll("'/work/rooms-relay'","'/work/concierge-private/rooms'").replace('auth.setup({ openBrowser: false','auth.setup({ forceLogin: true, openBrowser: false');}
if(command==='prepare'){
  const sandbox=state?await client.connect(state.sandboxId):await client.create({template:'base',isolation:'dedicated',cpu:1,memMb:2048,timeoutMs:3600000,lifecycle:{onTimeout:'kill'},metadata:{project:'TeracHackathon',service:'restricted-concierge'}});
  state??={sandboxId:sandbox.id,createdAt:new Date().toISOString(),restricted:true,expectedRoomsHandle:'@concierge'};
  await save();
  try{
    await sandbox.connect();
    await run(sandbox,'mkdir',['-p','/work/concierge-runtime','/work/concierge-private']);
    await run(sandbox,'chmod',['700','/work/concierge-private']);
    await run(sandbox,'npm',['install','--prefix','/work/concierge-runtime','node@22.22.3']);
    const installer=await fetch('https://rooms.wittlelabs.ai/install.sh',{signal:AbortSignal.timeout(15000)});
    if(!installer.ok)throw Error('ROOMS_INSTALLER_UNAVAILABLE');
    await sandbox.files.write('/work/install-rooms.sh',await installer.text());
    await run(sandbox,'/bin/sh',['/work/install-rooms.sh','--no-setup'],{PATH:'/work/concierge-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',WITTLE_ROOMS_HOME:'/work/rooms-install'});
    await sandbox.files.write('/work/concierge-auth.mjs',await authSource());
    state.prepared=true;await save();
    console.log(JSON.stringify({prepared:true,node:await run(sandbox,node,['--version']),expected_rooms_handle:'@concierge',legacy_runner_installed:false,model_key_uploaded:false}));
  }finally{sandbox.close();}
}else if(command==='authorize'){
  if(!state?.prepared)throw Error('PREPARE_FIRST');
  // Do not create another login for an uncertain still-running authorization.
  if(state.authExecutionId){const prior=await api(`/executions/${encodeURIComponent(state.authExecutionId)}`);if(prior.status==='running')throw Error('AUTHORIZATION_ALREADY_RUNNING');}
  const sandbox=await client.connect(state.sandboxId);try{await sandbox.connect();await sandbox.files.write('/work/concierge-auth.mjs',await authSource());}finally{sandbox.close();}
  const result=await api('/executions','POST',{cmd:node,args:['/work/concierge-auth.mjs'],cwd:'/work'});
  state.authExecutionId=result.executionId;await save();
  for(let i=0;i<30;i++){
    const view=await api(`/executions/${encodeURIComponent(result.executionId)}`);
    const line=(view.stdout || '').split('\n').find(l=>l.startsWith('{"authorization_url"'));
    if(line){
      const login=JSON.parse(line);await api('/tunnel','POST',{authMode:'authenticated',wakeOnHttp:true});const tunnel=await api('/tunnel');
      login.callback_origin=tunnel.urlTemplate.replace('{port}','53683');login.tunnel_token=tunnel.authToken;
      const loginPath=resolve(root,'.solari/concierge-login.json');await writeFile(loginPath,JSON.stringify(login)+'\n',{mode:0o600});
      const server=createCallbackServer(login,fetch,()=>{clearTimeout(expiry);server.close();unlink(loginPath).catch(()=>{});});
      const expiry=setTimeout(()=>server.close(),10*60_000);server.on('error',()=>clearTimeout(expiry));
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(53682,'127.0.0.1',resolve);});
      console.log(JSON.stringify({authorization_url:login.authorization_url,expected_account:'@concierge',callback_ready:true}));break;
    }
    if(view.status!=='running')throw Error('AUTHORIZATION_ENDED');
    await new Promise(r=>setTimeout(r,500));
  }
}else if(command==='status'){
  if(!state)console.log(JSON.stringify({prepared:false}));
  else{const view=await api('');console.log(JSON.stringify({state:view.state,prepared:state.prepared===true,expectedRoomsHandle:state.expectedRoomsHandle,createdAt:state.createdAt}));}
}else if(command==='bind'){
  if(!state?.prepared || !state.candidateAgentName)throw Error('PREPARE_AND_AUTHORIZE_FIRST');
  const sandbox=await client.connect(state.sandboxId);
  try{
    await sandbox.connect();
    const code=`
import {createAuth} from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/auth.mjs';
import {mcp,request} from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/core.mjs';
import {writeFile,readFile} from 'node:fs/promises';
const server='https://rooms.wittlelabs.ai';
try {
 const auth=createAuth({server,dir:'/work/concierge-private/rooms',clientId:'client_01M5NX7KDR46Y1ZBP8J6054HQ5'});
 const owner=await auth.ownerToken();
 const name=${JSON.stringify(state.candidateAgentName)};
 try {const previous=JSON.parse(await readFile('/work/concierge-private/agent.json','utf8'));await request(server,'/relay/agents',{agent_id:previous.agent_id,active:true},owner);}catch(e){if(e.code!=='ENOENT')throw e;}
 const candidate=await request(server,'/relay/agents',{name,role:'Restricted concierge host',bio:'Private free-scoping host in Solari; no shell or model tools.'},owner);
 await request(server,'/relay/agents',{agent_id:candidate.agent_id,active:true},owner);
 const agent=await request(server,'/relay/agents',{name},owner);
 await writeFile('/work/concierge-private/agent.json',JSON.stringify(agent),{mode:0o600});
 const p=await mcp(server,agent.token,'get_profile',{});
 const address=await mcp(server,agent.token,'read_account',{action:'address'});
 const handle=address.handle?.startsWith('@')?address.handle:'@'+address.handle;
 if(handle!=='@concierge'||p.current_agent?.id!==agent.agent_id){
  await request(server,'/relay/agents',{agent_id:agent.agent_id,active:false},owner);
  console.log(JSON.stringify({verified:false,actual_account:handle,display_name:p.name,candidate_disabled:true}));
 }else{
  const binding={account:handle,display_name:p.name,owner_id:p.id,agent_id:agent.agent_id,agent_name:agent.name,bound_at:new Date().toISOString()};
  await writeFile('/work/concierge-private/identity.json',JSON.stringify(binding),{mode:0o600});
  console.log(JSON.stringify({verified:true,...binding}));
 }
}catch(e){console.log(JSON.stringify({verified:false,status:e.status || null,code:/^[A-Za-z_]+$/.test(e.code || '')?e.code:null}));}
`;
    const result=JSON.parse(await run(sandbox,node,['--input-type=module','-e',code]));
    if(result.verified){state.identity=result;await save();}
    console.log(JSON.stringify(result));
  }finally{sandbox.close();}
}else if(command==='create-test-room'){
  if(state?.identity?.account!=='@concierge')throw Error('VERIFIED_CONCIERGE_REQUIRED');
  state.roomRequestKey??=`concierge_free_${randomUUID()}`;await save();
  const sandbox=await client.connect(state.sandboxId);try{
    await sandbox.connect();
    const code=`import{readFile,writeFile}from'node:fs/promises';import{mcp}from'/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/core.mjs';const home='/work/concierge-private';try{const a=JSON.parse(await readFile(home+'/agent.json','utf8'));const p=await mcp('https://rooms.wittlelabs.ai',a.token,'get_profile',{});const address=await mcp('https://rooms.wittlelabs.ai',a.token,'read_account',{action:'address'});if(address.handle!=='@concierge'||p.current_agent?.id!==${JSON.stringify(state.identity.agent_id)})throw Error('WRONG_IDENTITY');const result=await mcp('https://rooms.wittlelabs.ai',a.token,'room',{action:'create_quick',handle:'@dillon',goal:'Private free-scoping test with Concierge',owner_approved:true,idempotency_key:${JSON.stringify(state.roomRequestKey)}});await writeFile(home+'/test-room-create.json',JSON.stringify(result),{mode:0o600});console.log(JSON.stringify({ok:true,result}));}catch(e){console.log(JSON.stringify({ok:false,status:e.status || null}));}`;
    const result=JSON.parse(await run(sandbox,node,['--input-type=module','-e',code]));
    if(result.ok){state.testRoom=result.result;await save();}
    console.log(JSON.stringify(result));
  }finally{sandbox.close();}
}else if(command==='start-listener'){
  if(state?.identity?.account!=='@concierge')throw Error('VERIFIED_CONCIERGE_REQUIRED');
  if(state.listenerExecutionId){const prior=await api(`/executions/${encodeURIComponent(state.listenerExecutionId)}`);if(prior.status==='running')throw Error('LISTENER_ALREADY_RUNNING');}
  const sandbox=await client.connect(state.sandboxId);
  try{
    await sandbox.connect();
    await sandbox.files.write('/work/concierge-listener.mjs',await readFile(new URL('./concierge-listener.mjs',import.meta.url),'utf8'));
    // Normalize the two owner-created JSON records from the bootstrap; no
    // credential content is returned through the command channel.
    await run(sandbox,node,['--input-type=module','-e',`import{readFile,writeFile}from'node:fs/promises';for(const name of ['agent','identity']){const path='/work/concierge-private/'+name+'.json';const raw=await readFile(path,'utf8');await writeFile(path,JSON.stringify(JSON.parse(raw.slice(0,raw.lastIndexOf('}')+1))),{mode:0o600});}`]);
    const execution=await api('/executions','POST',{cmd:node,args:['/work/concierge-listener.mjs'],cwd:'/work'});
    state.listenerExecutionId=execution.executionId;await save();
    for(let i=0;i<15;i++){
      const out=await sandbox.commands.run(node,{args:['--input-type=module','-e',`import{readFile}from'node:fs/promises';try{console.log(await readFile('/work/concierge-private/listener-status.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}`],cwd:'/work'});
      if(out.stdout.trim()){console.log(out.stdout.trim());break;}
      const view=await api(`/executions/${encodeURIComponent(state.listenerExecutionId)}`);if(view.status!=='running')throw Error('LISTENER_START_FAILED');
      await new Promise(r=>setTimeout(r,500));
    }
  }finally{sandbox.close();}
}else if(command==='listener-status'){
  if(!state?.listenerExecutionId)throw Error('LISTENER_NOT_STARTED');
  const view=await api(`/executions/${encodeURIComponent(state.listenerExecutionId)}`);
  const sandbox=await client.connect(state.sandboxId);try{await sandbox.connect();const status=JSON.parse(await run(sandbox,node,['--input-type=module','-e',`import{readFile}from'node:fs/promises';console.log(await readFile('/work/concierge-private/listener-status.json','utf8'));`]));console.log(JSON.stringify({execution_state:view.status,...status}));}finally{sandbox.close();}
}else throw Error('Commands: prepare, authorize, bind, create-test-room, start-listener, listener-status, status');
