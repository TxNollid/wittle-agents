// Dedicated guest control service: fixed room transport only, no model/CLI.
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createAuth} from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/auth.mjs';
import {mcp,request} from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/core.mjs';
import {createConciergeRoomsTransport} from './concierge-rooms-transport.mjs';
const home='/work/concierge-private',server='https://rooms.wittlelabs.ai';
const binding=JSON.parse(await readFile(`${home}/test-room-binding.json`,'utf8'));
const expected=createHash('sha256').update(`Bearer ${(await readFile(`${home}/transport-token`,'utf8')).trim()}`).digest();
const auth=createAuth({server,dir:`${home}/rooms`,clientId:'client_01M5NX7KDR46Y1ZBP8J6054HQ5'});
let agent=JSON.parse(await readFile(`${home}/agent.json`,'utf8'));
async function call(name,args,signal){
 if(Date.parse(agent.expires_at)<=Date.now()+60000){const next=await request(server,'/relay/agents',{name:agent.name},await auth.ownerToken());if(next.agent_id!==binding.agent_id)throw Error('IDENTITY_CHANGED');agent=next;await writeFile(`${home}/agent.json`,JSON.stringify(agent),{mode:0o600});}
 return mcp(server,agent.token,name,args,signal);
}
const db=new DatabaseSync(`${home}/transport.sqlite`);
const inbox=new DatabaseSync(`${home}/inbox.sqlite`);
inbox.exec(`PRAGMA busy_timeout=1000;CREATE TABLE IF NOT EXISTS concierge_wakes(event_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);`);
const transport=createConciergeRoomsTransport({binding,call,db});
await transport.identity();
const api=http.createServer(async(req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(data));};
 if(!timingSafeEqual(expected,createHash('sha256').update(req.headers.authorization || '').digest()))return send(401,{code:'UNAUTHORIZED'});
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&path==='/health')return send(200,{state:'restricted_room_transport',...await transport.identity(),room_id:binding.room_id,public_sales:false});
  if(req.method==='GET'&&path==='/wake-events')return send(200,{room_id:binding.room_id,agent_id:binding.agent_id,events:inbox.prepare('SELECT event_id,received_at,payload FROM concierge_wakes WHERE room_id=? AND acked=0 ORDER BY rowid LIMIT 20').all(binding.room_id).map(row=>({...row,event:JSON.parse(row.payload),payload:undefined}))});
  if(req.method!=='POST'||!['/read-room','/read-events','/send','/ack-wake'].includes(path))return send(404,{code:'NOT_FOUND'});
  let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>20000)return send(413,{code:'TOO_LARGE'});}
  const input=JSON.parse(raw||'{}');if(!input||Array.isArray(input)||typeof input!=='object')return send(400,{code:'INVALID_INPUT'});
  const signal=AbortSignal.timeout(20000);
  if(path==='/ack-wake'){if(Object.keys(input).some(k=>k!=='event_id')||typeof input.event_id!=='string')throw Error('INVALID_INPUT');inbox.prepare('UPDATE concierge_wakes SET acked=1 WHERE event_id=? AND room_id=?').run(input.event_id,binding.room_id);return send(200,{ok:true});}
  if(path==='/read-room'){if(Object.keys(input).length)throw Error('INVALID_INPUT');return send(200,await transport.readRoom({signal}));}
  if(path==='/read-events'){if(Object.keys(input).some(k=>!['cursor','limit'].includes(k)))throw Error('INVALID_INPUT');return send(200,await transport.readEvents({...input,signal}));}
  return send(200,await transport.send(input,{signal}));
 }catch(error){return send(503,{code:/^[A-Z_]{2,100}$/.test(error.code || error.message)?error.code || error.message:'TRANSPORT_UNAVAILABLE'});}
});
api.listen(3010,'0.0.0.0',()=>console.log(JSON.stringify({state:'restricted_room_transport',account:'@concierge',agent_id:binding.agent_id,room_id:binding.room_id,model_tools:[]})));
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>api.close(()=>{db.close();inbox.close();}));
