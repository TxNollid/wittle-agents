import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHost} from '../integration/host.mjs';
import {normalizeConciergeProposal as normalize,isExplicitScopeAgreement} from './concierge-proposal.mjs';
const proposal=brief_update=>({role:'host',reply:'Which constraints or exclusions should I save?',brief_update,tool_call:null,pause_reason:null});
test('only unqualified explicit agreement phrases become scope agreement',()=>{
 for(const text of ['yes',' Yes. ','YES!','Yes, that scope is correct. Please finalize the brief.'])assert.equal(isExplicitScopeAgreement(text),true);
 for(const text of ['yes, but change the pages','not yes','please pay','yes and charge my card','Yes, that scope is incorrect. Please finalize the brief.'])assert.equal(isExplicitScopeAgreement(text),false);
});
test('trusted classification saves explicit sentence agreement without a second model call',async()=>{
 const db=new DatabaseSync(':memory:');let generations=0,position=1;
 const brief={site_url:'https://wittlelabs.ai',pages:['https://wittlelabs.ai'],excluded_pages:[],goal:'Improve clarity',constraints:[],scope_summary:'Homepage review',findings_cap:5};
 const host=createHost({db,mode:'sandbox',quoteEnabled:false,propose:async()=>{generations++;return proposal(brief);},authorize:async()=>{},send:async x=>({room_id:x.room_id,delivery_key:x.delivery_key,message_id:`receipt_${++position}`,position})});
 const base={room_id:'room',buyer_id:'buyer'};
 const initial=await host.handle({...base,id:'scope',text:'Review homepage',kind:'message',position:1});
 const text='Yes, that scope is correct. Please finalize the brief.';
 assert.equal(isExplicitScopeAgreement(text),true);
 const agreed=await host.handle({...base,id:'agree',text,kind:'scope_agreed',scope_hash:initial.scope_hash,position:3});
 assert.equal(agreed.scope_agreed,true);assert.equal(agreed.state,'agreed');assert.equal(generations,1);assert.equal(host.inspect('room').scope_agreed,true);db.close();
});
test('actual null placeholders are omitted without inventing buyer consent',async()=>{
 const input=proposal({site_url:'https://wittlelabs.ai',pages:['https://wittlelabs.ai'],constraints:null,exclusions:null});
 const db=new DatabaseSync(':memory:');let sent;
 const host=createHost({db,mode:'sandbox',quoteEnabled:false,propose:async()=>normalize(input),authorize:async()=>{},send:async x=>(sent=x,{room_id:x.room_id,delivery_key:x.delivery_key,message_id:'receipt',position:2})});
 const result=await host.handle({id:'source',room_id:'room',buyer_id:'buyer',text:'Homepage only',kind:'message',position:1});
 assert.equal(result.state,'scoping');assert.ok(sent);assert.deepEqual(result.brief,{site_url:'https://wittlelabs.ai',pages:['https://wittlelabs.ai']});assert.equal(result.scope_agreed,false);assert.equal(input.brief_update.constraints,null);db.close();
});
test('explicit empty lists survive; unknown non-null fields remain rejected by host',async()=>{
 assert.deepEqual(normalize(proposal({constraints:[],excluded_pages:[]})).brief_update,{constraints:[],excluded_pages:[]});
 assert.equal(normalize(proposal({site_url:'wittlelabs.ai'})).brief_update.site_url,'https://wittlelabs.ai');
 const db=new DatabaseSync(':memory:');let sends=0;
 const host=createHost({db,mode:'sandbox',quoteEnabled:false,propose:async()=>normalize(proposal({exclusions:['private']})),authorize:async()=>{},send:async()=>{sends++;}});
 await assert.rejects(host.handle({id:'source',room_id:'room',buyer_id:'buyer',text:'test',kind:'message',position:1}),{code:'FORBIDDEN_BRIEF_FIELD'});assert.equal(sends,0);db.close();
});
