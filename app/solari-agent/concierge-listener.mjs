// Dedicated sandbox agent listener. No coding-agent runner, model tools,
// arbitrary commands, browser automation, or account/profile mutation.
import {createAuth} from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/auth.mjs';
import {mcp,request} from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/core.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
const home='/work/concierge-private';
const server='https://rooms.wittlelabs.ai';
const identity=JSON.parse(await readFile(`${home}/identity.json`,'utf8'));
if(identity.account!=='@concierge')throw Error('CONCIERGE_IDENTITY_REQUIRED');
const auth=createAuth({server,dir:`${home}/rooms`,clientId:'client_01M5NX7KDR46Y1ZBP8J6054HQ5'});
const controller=new AbortController();for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>controller.abort());
async function save(name,value){await writeFile(`${home}/${name}.tmp`,JSON.stringify(value)+'\n',{mode:0o600});await rename(`${home}/${name}.tmp`,`${home}/${name}.json`);}
let agent=JSON.parse(await readFile(`${home}/agent.json`,'utf8'));
let cursor;try{cursor=JSON.parse(await readFile(`${home}/inbox-cursor.json`,'utf8')).cursor;}catch(e){if(e.code!=='ENOENT')throw e;}
const inbox=new DatabaseSync(`${home}/inbox.sqlite`);
inbox.exec(`PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS inbox_cursor(id INTEGER PRIMARY KEY,cursor TEXT);CREATE TABLE IF NOT EXISTS concierge_wakes(event_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);`);
cursor=inbox.prepare('SELECT cursor FROM inbox_cursor WHERE id=1').get()?.cursor || cursor;
async function token(){
 if(Date.parse(agent.expires_at)<=Date.now()+60000){const next=await request(server,'/relay/agents',{name:identity.agent_name},await auth.ownerToken());if(next.agent_id!==identity.agent_id)throw Error('AGENT_IDENTITY_CHANGED');agent=next;await save('agent',agent);}
 return agent.token;
}
async function verify(){const t=await token();const profile=await mcp(server,t,'get_profile',{},controller.signal);const address=await mcp(server,t,'read_account',{action:'address'},controller.signal);const handle=address?.handle?.startsWith('@')?address.handle:'@'+address?.handle;if(handle!=='@concierge'||profile.id!==identity.owner_id||profile.current_agent?.id!==identity.agent_id)throw Error('CONCIERGE_IDENTITY_CHANGED');}
await verify();
await save('listener-status',{state:'connected_waiting_for_test_room',...identity,pid:process.pid,last_identity_check:new Date().toISOString(),model_tools:[],legacy_runner:false,public_sales:false});
while(!controller.signal.aborted){
 try{
  const result=await mcp(server,await token(),'read_inbox',{action:'wait',timeout_seconds:25,...(cursor?{cursor}:{})},controller.signal);
  if(typeof result.cursor!=='string')throw Error('INBOX_CURSOR_REQUIRED');
  let binding;try{binding=JSON.parse(await readFile(`${home}/test-room-binding.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const accepted=(result.events || []).filter(e=>binding?.agent_id===identity.agent_id && Date.parse(binding.expires_at)>Date.now() && e.room_id===binding.room_id && typeof e.message_id==='string');
  // Persist authorized wake records BEFORE committing the opaque cursor.
  inbox.exec('BEGIN IMMEDIATE');try{for(const event of accepted)inbox.prepare('INSERT OR IGNORE INTO concierge_wakes VALUES(?,?,?,?,0)').run(event.message_id,event.room_id,JSON.stringify(event),new Date().toISOString());inbox.prepare('INSERT OR REPLACE INTO inbox_cursor VALUES(1,?)').run(result.cursor);inbox.exec('COMMIT');}catch(error){inbox.exec('ROLLBACK');throw error;}
  cursor=result.cursor;await save('inbox-cursor',{cursor});
  await save('listener-status',{state:binding?'connected_room_bound':'connected_waiting_for_test_room',...identity,pid:process.pid,last_inbox_wait:new Date().toISOString(),...(accepted.length?{last_wake:{room_id:binding.room_id,message_id:accepted.at(-1).message_id,received_at:new Date().toISOString()}}:{}),model_tools:[],legacy_runner:false,public_sales:false});
 }catch(error){if(controller.signal.aborted)break;await save('listener-status',{state:'unavailable',...identity,pid:process.pid,reason:'INBOX_UNAVAILABLE',at:new Date().toISOString(),public_sales:false});break;}
}
inbox.close();
