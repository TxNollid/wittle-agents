// One-room private demonstration supervisor. Reuses the reviewed host/proposer
// stores and policy. Inference/its durable budget stay on the trusted controller;
// the remote Solari agent owns its authenticated identity, inbox and transport.
import {DatabaseSync} from 'node:sqlite';
import {mkdir,chmod,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createOpenRouterParent} from './openrouter-parent.mjs';
import {createConciergeSolariClient} from './concierge-solari-client.mjs';
import {createHost} from '../integration/host.mjs';
import {createHostProposer} from '../rooms-entry/host-proposal.mjs';
import {formatConciergeMessage} from './concierge-message.mjs';
import {normalizeConciergeProposal,isExplicitScopeAgreement} from './concierge-proposal.mjs';
import {controllerConfig} from './controller-config.mjs';
const config=await controllerConfig();
const {directory}=config;
await mkdir(directory,{recursive:true,mode:0o700});
const client=await createConciergeSolariClient({solariApiKey:config.solariApiKey,statePath:config.statePath});
const binding=client.binding;
const parent=await createOpenRouterParent({dbPath:join(directory,'openrouter-testing.sqlite'),keyPath:config.keyPath});
const db=new DatabaseSync(join(directory,'concierge-free.sqlite'));await chmod(join(directory,'concierge-free.sqlite'),0o600);
const system_prompt=(await Promise.all(['shared.md','host.md'].map(name=>readFile(new URL(`../host-prompts/${name}`,import.meta.url),'utf8')))).join('\n\n')+
 '\nThis is FREE scoping only. Checkout and paid work are disabled. Save and confirm the exact free brief without waiting for payment feasibility. Do not claim you browsed the site. Reply in compact JSON, short reply, and only explicitly supplied brief fields; aim below350 output tokens.'+
 '\nbrief_update permits ONLY site_url (absolute public URL string), pages (explicit URL array, 1–5), excluded_pages (URL array), goal (string), constraints (string array), scope_summary (plain summary string of the supplied task), findings_cap (integer 1–10). Omit unanswered fields entirely; never use null or the field exclusions. Explicit none means an empty array for constraints/excluded_pages. Preserve explicit page selection and update the saved goal when the buyer clarifies it. Do not ask again for already selected pages. Once all fields are supplied, summarize the exact scope and ask the buyer to reply yes; do not pause for paid feasibility or terms. The supervisor owns agreement. Do not prefix reply with Host:.';
const nativePropose=createHostProposer(parent,{buyer_id:binding.buyer_id,room_id:binding.room_id,mode:'sandbox',prompt_version:'host-free-v2',system_prompt});
const propose=async state=>normalizeConciergeProposal(await nativePropose(state));
async function member(){const room=await client.readRoom();if(!room.members?.some(m=>m.id===binding.buyer_id))throw Error('BUYER_NOT_JOINED');return room;}
async function source(id){const result=await client.readEvents({cursor:0,limit:200});const event=result.events.find(e=>e.id===id);if(!event||event.sender!==binding.buyer_id||String(event.type).toLowerCase()!=='message'||typeof event.message!=='string')throw Error('SOURCE_NOT_BUYER_MESSAGE');return event;}
const host=createHost({db,mode:'sandbox',quoteEnabled:false,propose,
 authorize:async(event)=>{if(event.room_id!==binding.room_id||event.buyer_id!==binding.buyer_id)throw Error('WRONG_BINDING');await member();const current=await source(event.id);if(current.position!==event.position||current.message!==event.text)throw Error('SOURCE_MISMATCH');},
 send:async({room_id,source_event_id,delivery_key,text})=>{
  const original=await source(source_event_id);
  await member();
  const content=formatConciergeMessage(text);
  const receipt=await client.send({room_id,delivery_key,text:content});
  const history=await client.readEvents({cursor:receipt.position-1,limit:1});
  const sent=history.events.find(e=>e.id===receipt.message_id);
  if(receipt.room_id!==binding.room_id||receipt.delivery_key!==delivery_key||!sent||sent.sender!==binding.owner_id||sent.agent?.id!==binding.agent_id||sent.position!==receipt.position||sent.position<=original.position||sent.message!==content)throw Error('CANONICAL_REPLY_MISMATCH');
  return receipt;
 },
});
const heldEvents=new Set();
let stopped=false;for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stopped=true;});
const status=async(extra={})=>writeFile(join(directory,'concierge-free-status.json'),JSON.stringify({state:'private_free_test',account:'@concierge',room_id:binding.room_id,agent_id:binding.agent_id,pid:process.pid,local_inference_parent:true,public_sales:false,at:new Date().toISOString(),...extra})+'\n',{mode:0o600});
await status({ready_for_buyer_join:true});
console.log(JSON.stringify({state:'private_free_test_waiting_for_buyer',account:'@concierge',room_id:binding.room_id,agent_id:binding.agent_id,model_tools:[],local_inference_parent:true,public_sales:false}));
try{
 while(!stopped){
  try{
   const wakes=await client.wakeEvents();
   for(const wake of wakes.events){
    if(stopped)break;
    if(heldEvents.has(wake.event_id))continue;
    const result=await client.readEvents({cursor:0,limit:200});const e=result.events.find(x=>x.id===wake.event_id);
    if(!e)throw Error('SOURCE_UNAVAILABLE');
    if(e.sender!==binding.buyer_id||String(e.type).toLowerCase()!=='message'){await client.ackWake(wake.event_id);continue;}
    await member();
    const current=host.inspect(binding.room_id);
    const agreement=current&&['site_url','pages','excluded_pages','goal','constraints','scope_summary','findings_cap'].every(key=>Object.hasOwn(current.brief,key))&&isExplicitScopeAgreement(e.message);
    const outcome=await host.handle({id:e.id,room_id:binding.room_id,buyer_id:binding.buyer_id,text:e.message,kind:agreement?'scope_agreed':'message',position:e.position,...(agreement?{scope_hash:current.scope_hash}:{})});
    await status({last_source_event_id:e.id,last_reply_message_id:outcome.message_id || null,scope_agreed:outcome.scope_agreed,replies_used:outcome.replies_used,host_state:outcome.state});
    if(outcome.state!=='needs_attention')await client.ackWake(wake.event_id);
    else heldEvents.add(wake.event_id); // Preserve durable hold without a polling/reply loop.
    console.log(JSON.stringify({source_event_id:e.id,reply_message_id:outcome.message_id || null,host_state:outcome.state,scope_agreed:outcome.scope_agreed}));
   }
  }catch(error){await status({last_error:/^[A-Z_]{2,100}$/.test(error.code || error.message)?error.code || error.message:'FREE_TEST_UNAVAILABLE'});}
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
}finally{await host.idle();db.close();await parent.close();}
