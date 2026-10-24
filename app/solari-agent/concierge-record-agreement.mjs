// Operator-only recovery for a real, already-processed explicit FREE agreement.
// It cannot create checkout/payment authority or synthesize a buyer event.
import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {hashOffer} from '../fulfillment/index.mjs';
import {createConciergeSolariClient} from './concierge-solari-client.mjs';
import {isExplicitScopeAgreement} from './concierge-proposal.mjs';
import {formatConciergeMessage} from './concierge-message.mjs';
process.loadEnvFile(new URL('../../.env',import.meta.url));
const sourceId=process.argv[2];
// A manually reviewed longer confirmation requires an explicit operator hash pin.
const confirmedHash=process.argv[3];
if(!/^[A-Za-z0-9_-]{1,200}$/.test(sourceId||''))throw Error('SOURCE_ID_REQUIRED');
const client=await createConciergeSolariClient({solariApiKey:process.env.SOLARI_API_KEY});
const b=client.binding;
const room=await client.readRoom();
if(!room.members.some(m=>m.id===b.buyer_id))throw Error('BUYER_NOT_JOINED');
const history=await client.readEvents({cursor:0,limit:200});
const buyerEvents=history.events.filter(e=>e.type==='MESSAGE'&&e.sender===b.buyer_id);
const source=buyerEvents.at(-1);
if(history.has_more||source?.id!==sourceId||source.agent?.id||!(isExplicitScopeAgreement(source.message)||(typeof confirmedHash==='string'&&/^[a-f0-9]{64}$/.test(confirmedHash)&&/^Yes, I confirm this exact scope is complete:/.test(source.message))))throw Error('EXACT_CURRENT_BUYER_AGREEMENT_REQUIRED');
const db=new DatabaseSync(join(homedir(),'.local/state/wittle-agents/concierge-free.sqlite'));
try{
 const current=db.prepare('SELECT * FROM integration_briefs WHERE room_id=?').get(b.room_id);
 const brief=JSON.parse(current.brief),scopeHash=hashOffer(brief);
 if(confirmedHash&&confirmedHash!==scopeHash)throw Error('OPERATOR_SCOPE_PIN_MISMATCH');
 if(current.buyer_id!==b.buyer_id||current.quote!==null||!['site_url','pages','excluded_pages','goal','constraints','scope_summary','findings_cap'].every(k=>Object.hasOwn(brief,k)))throw Error('COMPLETE_FREE_SCOPE_REQUIRED');
 const original=db.prepare('SELECT * FROM integration_host_events WHERE event_id=?').get(sourceId);
 if(original?.room_id!==b.room_id||original.phase!=='sent'||JSON.parse(original.result).scope_hash!==scopeHash)throw Error('PROCESSED_UNCHANGED_SOURCE_REQUIRED');
 const presented=db.prepare("SELECT result,receipt FROM integration_host_events WHERE room_id=? AND phase='sent'").all(b.room_id).find(row=>{
  const r=JSON.parse(row.result),p=JSON.parse(row.receipt);
  return r.scope_hash===scopeHash&&hashOffer(r.brief)===scopeHash&&p.position<source.position&&history.events.some(e=>e.id===p.message_id&&e.position===p.position&&e.agent?.id===b.agent_id&&e.sender===b.owner_id&&e.message===formatConciergeMessage(r.reply));
 });
 if(!presented)throw Error('PRIOR_EXACT_SCOPE_PRESENTATION_REQUIRED');
 const key=`agreement_${hashOffer({sourceId,scopeHash})}`;
 const proof={source_event_id:sourceId,source_position:source.position,scope_hash:scopeHash,presentation_message_id:JSON.parse(presented.receipt).message_id,delivery_key:key};
 db.exec('CREATE TABLE IF NOT EXISTS concierge_agreement_recovery(source_event_id TEXT PRIMARY KEY,proof TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT)');
 db.exec('BEGIN IMMEDIATE');
 try{
  const previous=db.prepare('SELECT * FROM concierge_agreement_recovery WHERE source_event_id=?').get(sourceId);
  if(previous&&previous.proof!==JSON.stringify(proof))throw Error('AGREEMENT_CONFLICT');
  if(!previous)db.prepare("INSERT INTO concierge_agreement_recovery VALUES(?,?,'accepted_scope',NULL)").run(sourceId,JSON.stringify(proof));
  db.prepare('UPDATE integration_briefs SET agreed_hash=? WHERE room_id=? AND brief=? AND quote IS NULL').run(scopeHash,b.room_id,current.brief);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 const old=db.prepare('SELECT receipt FROM concierge_agreement_recovery WHERE source_event_id=?').get(sourceId);
 const notice='Host: Your exact free scope is agreed and saved. No payment or audit has started.';
 const receipt=old.receipt?JSON.parse(old.receipt):await client.send({room_id:b.room_id,delivery_key:key,text:notice});
 const events=await client.readEvents({cursor:receipt.position-1,limit:1});
 const sent=events.events.find(e=>e.id===receipt.message_id);
 if(receipt.room_id!==b.room_id||receipt.delivery_key!==key||!sent||sent.agent?.id!==b.agent_id||sent.sender!==b.owner_id||sent.position!==receipt.position||sent.position<=source.position||sent.message!==notice)throw Error('AGREEMENT_NOTICE_UNVERIFIED');
 db.prepare("UPDATE concierge_agreement_recovery SET state='sent',receipt=? WHERE source_event_id=?").run(JSON.stringify(receipt),sourceId);
 console.log(JSON.stringify({scope_agreed:true,...proof,reply_message_id:receipt.message_id,reply_position:receipt.position,operator_reconciliation:true,model_calls:0,quote_enabled:false}));
}finally{db.close();}
