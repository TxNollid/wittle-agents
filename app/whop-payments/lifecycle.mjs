// Trusted supervisor lifecycle ports. No public/model completion or revision authority.
import {createHmac,randomUUID} from 'node:crypto';
import {canonical,hash,problem} from './controller.mjs';
import {validateWire} from './v2.mjs';
const need=(ok,status,message)=>{if(!ok)throw problem(status,message);};
const key=v=>typeof v==='string' && /^[A-Za-z0-9_-]{8,100}$/.test(v);
export function createLifecycle({db,controller:c,config,options={},now=Date.now}) {
 if(!db.prepare('PRAGMA table_info(runs)').all().some(col=>col.name==='revision')) c.transaction(()=>{
  db.exec(`ALTER TABLE runs RENAME TO runs_before_revision;
   CREATE TABLE runs (id TEXT PRIMARY KEY,order_id TEXT NOT NULL,request_id TEXT UNIQUE NOT NULL,status TEXT NOT NULL,lease_until INTEGER NOT NULL,budget_minor INTEGER NOT NULL,spent_minor INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,UNIQUE(order_id,revision));
   INSERT INTO runs (id,order_id,request_id,status,lease_until,budget_minor,spent_minor) SELECT id,order_id,request_id,status,lease_until,budget_minor,spent_minor FROM runs_before_revision;
   DROP TABLE runs_before_revision;`);
 });
 db.exec(`CREATE TABLE IF NOT EXISTS run_completions (run_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,record TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS revision_claims (order_id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,request_id TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,run_id TEXT UNIQUE NOT NULL);`);
 const admin=actor=>need(actor?.role==='operator',403,'Operator access required');
 const token=run=>'run.'+run.id+'.'+createHmac('sha256',config.PAYMENTS_SERVICE_TOKEN).update(run.id+':'+run.lease_until).digest('hex');
 function eligible(actor,orderId) {
  const o=c.viewOrder(actor,orderId),q=c.viewQuote(actor,o.quote_id),accept=db.prepare('SELECT * FROM payment_acceptances WHERE order_id=?').get(orderId);
  need(o.payment_status==='paid' && q.state==='active' && !['cancelled','needs_attention','disputed','legacy_unbound'].includes(o.workflow_status),409,'Paid agreement is held or revoked');
  need(q.snapshot.offer && accept?.quote_hash===o.quote_hash && accept.payment_id===o.payment_id && accept.room_id===q.snapshot.offer.room_id,409,'V2 verified acceptance required');
  need(!c.principal(q.buyer_id)?.revoked && !c.principal(q.seller_id)?.revoked,409,'Quote party revoked');
  return o;
 }
 function completeRun(actor,attemptId,input) {
  admin(actor);need(input && key(input.request_id),400,'Completion retry key required');
  validateWire('Result',input.result);validateWire('Delivery',input.delivery);
  const digest=hash(canonical({result:input.result,delivery:input.delivery}));
  return c.transaction(()=>{
   const prior=db.prepare('SELECT * FROM run_completions WHERE run_id=? OR request_id=?').get(attemptId,input.request_id);
   if(prior){need(prior.run_id===attemptId && prior.request_id===input.request_id && prior.payload_hash===digest,409,'Completion retry conflict');return JSON.parse(prior.record);}
   const run=db.prepare('SELECT * FROM runs WHERE id=?').get(attemptId);
   need(run?.status==='running' && run.lease_until>now(),409,'Active run lease required for completion');
   const o=eligible(actor,run.order_id),offer=o.quote_snapshot.offer,r=input.result,d=input.delivery;
   need(o.workflow_status==='running' && o.project?.room_id===offer.room_id && o.project.access_ready===1,409,'Bound running project required');
   for(const value of [r,d])need(value.order_id===o.id && value.job_id===o.id && value.attempt_id===run.id && value.room_id===offer.room_id && value.quote_hash===o.quote_hash && value.revision===run.revision && value.mode===(config.PAYMENT_EVIDENCE_LEVEL==='fixture'?'fixture':'sandbox'),403,'Completion result/delivery binding mismatch');
   need(d.artifact_id===r.report.artifact_id && r.findings_count<=offer.scope.findings_cap && Date.parse(r.completed_at)<=now()+5000 && Date.parse(d.delivered_at)>=Date.parse(r.completed_at) && Date.parse(d.delivered_at)<=now()+5000,400,'Completion artifact, count or timestamp mismatch');
   const record={order_id:o.id,attempt_id:run.id,revision:run.revision,state:run.revision?'revised':'delivered',result:r,delivery:d,completed_at:new Date(now()).toISOString(),reserved_minor:run.spent_minor};
   // Unknown/possibly-spent reservations stay charged. Only never-reserved cap is released.
   db.prepare("UPDATE runs SET status='completed',budget_minor=spent_minor WHERE id=?").run(run.id);
   db.prepare('UPDATE orders SET workflow_status=? WHERE id=?').run(record.state,o.id);
   db.prepare('INSERT INTO run_completions VALUES (?,?,?,?)').run(run.id,input.request_id,digest,canonical(record));
   return record;
  });
 }
 async function claimRevision(actor,orderId,input) {
  admin(actor);need(input && key(input.request_id) && typeof input.event_id==='string',400,'Revision source and retry key required');
  need(typeof options.readBuyerEvent==='function' && typeof options.membership==='function',503,'Trusted buyer event and membership ports required');
  const first=eligible(actor,orderId),offer=first.quote_snapshot.offer;
  const event=await options.readBuyerEvent(input.event_id);
  const completed=db.prepare('SELECT c.record FROM runs r JOIN run_completions c ON c.run_id=r.id WHERE r.order_id=? AND r.revision=0').get(orderId);
  const initialDelivery=completed ? JSON.parse(completed.record).delivery : null;
  let deliveryProof=null;
  if(event?.after_message_id!==initialDelivery?.message_id && initialDelivery && typeof options.readDeliveryReceipt==='function') deliveryProof=await options.readDeliveryReceipt({order_id:orderId,room_id:offer.room_id,message_id:initialDelivery.message_id});
  const proof=await options.membership({buyer_id:offer.buyer_id,room_id:offer.room_id});
  need(proof?.buyer_id===offer.buyer_id && proof.room_id===offer.room_id && proof.revoked_at===null && typeof proof.membership_id==='string' && typeof proof.source_event_id==='string' && Date.parse(proof.verified_at)<=now() && now()-Date.parse(proof.verified_at)<=60000 && Date.parse(proof.expires_at)>now() && proof.mode===(config.PAYMENT_EVIDENCE_LEVEL==='fixture'?'fixture':'sandbox') && proof.evidence_level===(config.PAYMENT_EVIDENCE_LEVEL==='fixture'?'fixture':'provider'),403,'Current buyer membership required');
  need(event?.id===input.event_id && event.actor_id===offer.buyer_id && event.room_id===offer.room_id && event.type==='revision' && event.in_scope===true && typeof event.instructions==='string' && event.instructions.trim() && event.instructions.length<=2000 && Array.isArray(event.pages) && event.pages.length>0 && event.pages.every(p=>offer.scope.pages.includes(p)),403,'Original in-scope buyer revision event required');
  if(input.event)need(canonical(input.event)===canonical(event),409,'Revision event changed from provider source');
  const digest=hash(canonical(event));
  return c.transaction(()=>{
   const o=eligible(actor,orderId);
   const prior=db.prepare('SELECT * FROM revision_claims WHERE order_id=? OR event_id=? OR request_id=?').get(orderId,input.event_id,input.request_id);
   if(prior){need(prior.order_id===orderId && prior.event_id===input.event_id && prior.request_id===input.request_id && prior.payload_hash===digest,409,'Revision already used or retry conflict');const run=db.prepare('SELECT * FROM runs WHERE id=?').get(prior.run_id);need(run.status==='running' && run.lease_until>now(),409,'Revision lease inactive; reconcile existing attempt');return {...run,token:token(run)};}
   const initial=db.prepare('SELECT r.*,c.record FROM runs r JOIN run_completions c ON c.run_id=r.id WHERE r.order_id=? AND r.revision=0').get(orderId);
   need(initial?.status==='completed' && o.workflow_status==='delivered' && offer.scope.revisions===1,409,'Delivered initial report and unused revision required');
   const receipt=JSON.parse(initial.record).delivery;
   need(event.after_message_id===receipt.message_id || (deliveryProof?.message_id===receipt.message_id && deliveryProof.room_id===offer.room_id && Number.isSafeInteger(deliveryProof.position) && deliveryProof.position>0 && Number.isSafeInteger(event.position) && event.position>deliveryProof.position),403,'Buyer revision must reference the delivered report');
   need(!db.prepare("SELECT id FROM runs WHERE status='running'").get(),409,'A worker is already running; reconcile first');
   const spent=db.prepare('SELECT coalesce(sum(spent_minor),0) n FROM runs WHERE order_id=?').get(orderId).n;
   const remaining=o.quote_snapshot.execution_cap_minor-spent;
   const allowance=db.prepare('SELECT allowance_minor n FROM execution_budget WHERE id=1').get().n;
   const reserved=db.prepare('SELECT coalesce(sum(budget_minor),0) n FROM runs').get().n;
   need(remaining>0 && reserved+remaining<=allowance,409,'Revision or owner budget exhausted');
   const run={id:randomUUID(),order_id:orderId,request_id:input.request_id,status:'running',lease_until:now()+15*60000,budget_minor:remaining,spent_minor:0,revision:1};
   db.prepare('INSERT INTO runs (id,order_id,request_id,status,lease_until,budget_minor,spent_minor,revision) VALUES (?,?,?,?,?,?,?,1)').run(run.id,orderId,input.request_id,run.status,run.lease_until,remaining,0);
   db.prepare('INSERT INTO revision_claims VALUES (?,?,?,?,?)').run(orderId,input.event_id,input.request_id,digest,run.id);
   db.prepare("UPDATE orders SET workflow_status='running' WHERE id=?").run(orderId);
   return {...run,token:token(run)};
  });
 }
 return {completeRun,claimRevision};
}
