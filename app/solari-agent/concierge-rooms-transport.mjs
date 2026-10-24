// Server-only room transport. `call` is an authenticated native Rooms client,
// never a model tool. No credential, shell, browser or inference is exposed.
import {createHash} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code,status:503});
const id=x=>typeof x==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(x);
const hash=x=>createHash('sha256').update(x).digest('hex');

export function createConciergeRoomsTransport({binding,call,db,now=Date.now}) {
  if(!binding || ![binding.room_id,binding.agent_id,binding.owner_id,binding.buyer_id].every(id) ||
     binding.account!=='@concierge' || binding.mode!=='sandbox' || typeof call!=='function' || !db?.prepare ||
     typeof binding.join_url!=='string' || new URL(binding.join_url).origin!=='https://rooms.wittlelabs.ai' ||
     !(Date.parse(binding.expires_at)>now()))throw fail('VERIFIED_CONCIERGE_BINDING_REQUIRED');
  const bound=structuredClone(binding);
  db.exec(`CREATE TABLE IF NOT EXISTS concierge_send_intents(
    delivery_key TEXT PRIMARY KEY, room_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
    state TEXT NOT NULL,receipt TEXT);`);
  async function identity(signal) {
    const p=await call('get_profile',{},signal);
    const address=await call('read_account',{action:'address'},signal);
    const handle=address?.handle?.startsWith('@')?address.handle:'@'+address?.handle;
    if(handle!=='@concierge' || p?.id!==bound.owner_id || p.current_agent?.id!==bound.agent_id)throw fail('CONCIERGE_IDENTITY_MISMATCH');
    return {account:'@concierge',owner_id:p.id,agent_id:p.current_agent.id};
  }
  async function readRoom({signal}={}) {
    if(Date.parse(bound.expires_at)<=now())throw fail('TEST_BINDING_EXPIRED');
    await identity(signal);
    const room=await call('read_room',{action:'get',room_id:bound.room_id},signal);
    const members=room?.members;
    if(room?.room_id!==bound.room_id || room.state!=='OPEN' || !(room.expires_at>now()) || !Array.isArray(members) ||
       members.some(m=>![bound.owner_id,bound.buyer_id].includes(m.id)) ||
       !members.some(m=>m.id===bound.owner_id && (m.agents || [m.agent]).some(a=>a?.id===bound.agent_id)))throw fail('ROOM_BINDING_UNVERIFIED');
    // No lead/wake/readiness claim is inferred from configured event delivery.
    return room;
  }
  async function readEvents({cursor=0,limit=100,signal}={}) {
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw fail('INVALID_INPUT');
    await readRoom({signal});
    const result=await call('read_room',{action:'events',room_id:bound.room_id,cursor,limit},signal);
    if(result?.room_id!==bound.room_id || !Array.isArray(result.events) || result.events.some(e=>e.room_id && e.room_id!==bound.room_id))throw fail('ROOM_EVENTS_MISMATCH');
    return result;
  }
  async function send(input,{signal}={}) {
    if(!input || Object.keys(input).some(k=>!['room_id','delivery_key','text'].includes(k)) || input.room_id!==bound.room_id ||
       !id(input.delivery_key) || typeof input.text!=='string' || !input.text.trim() || input.text.length>4000)throw fail('INVALID_INPUT');
    const content=input.text,key=input.delivery_key,digest=hash(content);
    await readRoom({signal});
    const prior=db.prepare('SELECT * FROM concierge_send_intents WHERE delivery_key=?').get(key);
    if(prior){if(prior.room_id!==bound.room_id||prior.payload_hash!==digest)throw fail('SEND_CONFLICT');if(prior.state==='sent')return JSON.parse(prior.receipt);throw fail('SEND_RECONCILIATION_REQUIRED');}
    db.prepare("INSERT INTO concierge_send_intents VALUES(?,?,?,'sending',NULL)").run(key,bound.room_id,digest);
    try {
      const sent=await call('room',{action:'send',room_id:bound.room_id,message:content,idempotency_key:key},signal);
      if(!id(sent?.id) || !Number.isSafeInteger(sent.position) || sent.position<1 ||
         (sent.agent?.id && sent.agent.id!==bound.agent_id) || (sent.room_id && sent.room_id!==bound.room_id))throw fail('SEND_RECEIPT_MISMATCH');
      const receipt={room_id:bound.room_id,delivery_key:key,message_id:sent.id,position:sent.position};
      db.prepare("UPDATE concierge_send_intents SET state='sent',receipt=? WHERE delivery_key=? AND state='sending'").run(JSON.stringify(receipt),key);
      return receipt;
    }catch{db.prepare("UPDATE concierge_send_intents SET state='needs_attention' WHERE delivery_key=? AND state='sending'").run(key);throw fail('SEND_RECONCILIATION_REQUIRED');}
  }
  return Object.freeze({binding:structuredClone(bound),identity,readRoom,readEvents,send});
}
