// Trusted read-only port. Evidence for an attributable FREE agreement, never a
// bearer capability, specialist approval, payment authorization or full readiness.
import {hashOffer} from '../fulfillment/index.mjs';
import {formatConciergeMessage} from './concierge-message.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export function createConciergeAgreementProof({client,db,now=Date.now}){
 const b=client.binding;
 function current(){
  const row=db.prepare('SELECT * FROM integration_briefs WHERE room_id=?').get(b.room_id);
  need(row&&row.buyer_id===b.buyer_id,'SAVED_AGREEMENT_REQUIRED');
  const brief=JSON.parse(row.brief),scope_hash=hashOffer(brief);
  need(row.agreed_hash===scope_hash,'SAVED_AGREEMENT_REQUIRED');
  return {row,brief,scope_hash};
 }
 return async function resolve(input,{signal}={}){
  need(input?.buyer_id===b.buyer_id&&input.room_id===b.room_id,'AGREEMENT_BINDING_MISMATCH');
  const saved=current();
  need(input.scope_hash===saved.scope_hash,'AGREEMENT_SCOPE_MISMATCH');
  const audit=db.prepare('SELECT * FROM concierge_agreement_recovery WHERE source_event_id=?').get(input.source_event_id);
  need(audit?.state==='sent','AGREEMENT_SOURCE_UNVERIFIED');
  const proof=JSON.parse(audit.proof),receipt=JSON.parse(audit.receipt);
  need(proof.scope_hash===saved.scope_hash,'AGREEMENT_SCOPE_MISMATCH');
  const health=await client.health({signal});
  need(health.account==='@concierge'&&health.owner_id===b.owner_id&&health.agent_id===b.agent_id&&health.room_id===b.room_id,'CONCIERGE_IDENTITY_MISMATCH');
  const history=await client.readEvents({cursor:0,limit:200,signal});
  need(history.room_id===b.room_id&&!history.has_more,'CANONICAL_HISTORY_REQUIRED');
  const source=history.events.find(e=>e.id===input.source_event_id);
  const presented=history.events.find(e=>e.id===proof.presentation_message_id);
  const notice=history.events.find(e=>e.id===receipt.message_id);
  need(source?.sender===b.buyer_id&&source.type==='MESSAGE'&&!source.agent?.id&&source.position===proof.source_position,'AGREEMENT_SOURCE_UNVERIFIED');
  const recorded=db.prepare("SELECT result,receipt FROM integration_host_events WHERE room_id=? AND phase='sent'").all(b.room_id).find(row=>JSON.parse(row.receipt).message_id===proof.presentation_message_id);
  need(recorded,'AGREEMENT_PRESENTATION_UNVERIFIED');
  const result=JSON.parse(recorded.result);
  need(presented?.sender===b.owner_id&&presented.agent?.id===b.agent_id&&presented.position<source.position&&result.scope_hash===saved.scope_hash&&hashOffer(result.brief)===saved.scope_hash&&presented.message===formatConciergeMessage(result.reply),'AGREEMENT_PRESENTATION_UNVERIFIED');
  need(notice?.sender===b.owner_id&&notice.agent?.id===b.agent_id&&notice.position===receipt.position&&notice.position>source.position&&notice.message==='Host: Your exact free scope is agreed and saved. No payment or audit has started.','AGREEMENT_RECEIPT_UNVERIFIED');
  const room=await client.readRoom({signal});
  need(room.room_id===b.room_id&&room.state==='OPEN'&&room.members.some(m=>m.id===b.buyer_id)&&room.members.every(m=>[b.owner_id,b.buyer_id].includes(m.id)),'CURRENT_MEMBERSHIP_REQUIRED');
  const runtime=await client.runtime({signal});
  const expires=Math.min(Date.parse(b.expires_at),Date.parse(runtime.expires_at),room.expires_at,now()+30000);
  need(runtime.state==='running'&&Date.parse(runtime.observed_at)<=now()&&now()-Date.parse(runtime.observed_at)<30000&&expires>now(),'CURRENT_RUNTIME_REQUIRED');
  need(current().scope_hash===saved.scope_hash,'AGREEMENT_CHANGED');
  return {mode:'sandbox',evidence_level:'provider',purpose:'free_agreement',buyer_id:b.buyer_id,room_id:b.room_id,agent_id:b.agent_id,scope_hash:saved.scope_hash,scope_version:saved.row.version,brief:saved.brief,source_event_id:source.id,source_position:source.position,presentation_message_id:presented.id,agreement_message_id:notice.id,operator_reconciliation:true,join_url:b.join_url,verified_at:new Date(now()).toISOString(),expires_at:new Date(expires).toISOString(),provider_runtime_expires_at:runtime.expires_at,specialist_confirmed:false,paid_authority:false};
 };
}
