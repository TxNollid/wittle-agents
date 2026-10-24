import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createConciergeRoomsTransport} from './concierge-rooms-transport.mjs';
const binding={account:'@concierge',mode:'sandbox',owner_id:'concierge-owner',agent_id:'concierge-agent',buyer_id:'buyer-owner',room_id:'test-room',join_url:'https://rooms.wittlelabs.ai/synthetic-private-join',expires_at:'2099-01-01T00:00:00Z'};
function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());let sends=0,wrong=false,lose=false;const call=async(name,args)=>{
 if(name==='get_profile')return {name:wrong?'@dillon':'@concierge',id:binding.owner_id,current_agent:{id:binding.agent_id}};
 if(name==='read_account')return {handle:wrong?'@dillon':'@concierge'};
 assert.equal(args.room_id,binding.room_id);
 if(name==='read_room'&&args.action==='get')return {room_id:binding.room_id,state:'OPEN',expires_at:Date.now()+60000,members:[{id:binding.owner_id,agents:[{id:binding.agent_id}]},{id:binding.buyer_id}]};
 if(name==='read_room')return {room_id:binding.room_id,events:[],cursor:0};
 assert.equal(name,'room');assert.equal(args.action,'send');sends++;if(lose)throw Error('lost response');return {id:'provider-message',position:2,agent:{id:binding.agent_id}};
 };return {transport:createConciergeRoomsTransport({binding,call,db}),sends:()=>sends,wrong:()=>wrong=true,lose:()=>lose=true};}
test('verified one-room send/read preserves receipt/idempotency and rejects room or operation expansion',async t=>{
 const f=setup(t);const input={room_id:'test-room',delivery_key:'saved-reply',text:'private test reply'};
 const a=await f.transport.send(input);assert.equal(a.message_id,'provider-message');assert.deepEqual(await f.transport.send(input),a);assert.equal(f.sends(),1);
 await assert.rejects(f.transport.send({...input,room_id:'other-room'}),e=>e.code==='INVALID_INPUT');
 await assert.rejects(f.transport.send({...input,operation:'agents'}),e=>e.code==='INVALID_INPUT');
 await assert.rejects(f.transport.send({...input,text:'different'}),e=>e.code==='SEND_CONFLICT');
 await f.transport.readEvents();f.wrong();await assert.rejects(f.transport.readRoom(),e=>e.code==='CONCIERGE_IDENTITY_MISMATCH');
});
test('unknown send cannot be blindly replayed',async t=>{const f=setup(t);f.lose();const input={room_id:'test-room',delivery_key:'unknown-send',text:'reply'};await assert.rejects(f.transport.send(input));await assert.rejects(f.transport.send(input),e=>e.code==='SEND_RECONCILIATION_REQUIRED');assert.equal(f.sends(),1);});
