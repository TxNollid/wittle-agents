// wa-v2.1 gateway: authority and terms are supplied by trusted supervisors only.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, hash, problem } from './controller.mjs';
const schema = JSON.parse(readFileSync(new URL('../contracts/v2.schema.json', import.meta.url)));
const need = (ok, status, message) => { if (!ok) throw problem(status, message); };
// The frozen schema uses this small JSON Schema subset. Unknown schema keywords
// are annotations, not application authority; membership is checked separately.
export function validateWire(name, value) {
  function check(rule, value) {
    if (rule.$ref) return check(schema.$defs[rule.$ref.split('/').at(-1)], value);
    if (rule.anyOf) return rule.anyOf.some(r => check(r, value));
    if (Object.hasOwn(rule,'const') && canonical(value) !== canonical(rule.const)) return false;
    if (rule.enum && !rule.enum.includes(value)) return false;
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (rule.type && !types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? Number.isFinite(value) : typeof value === type)) return false;
    if (typeof value === 'string') {
      if (rule.minLength && value.length < rule.minLength || rule.maxLength && value.length > rule.maxLength || rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
      if (rule.format === 'date-time' && !Number.isFinite(Date.parse(value))) return false;
      if (rule.format === 'uri') { try {new URL(value);} catch {return false;} }
    }
    if (typeof value === 'number' && (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum)) return false;
    if (Array.isArray(value)) {
      if (rule.minItems && value.length < rule.minItems || rule.maxItems && value.length > rule.maxItems || rule.uniqueItems && new Set(value.map(canonical)).size !== value.length) return false;
      if (rule.items && !value.every(v=>check(rule.items,v))) return false;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (rule.required?.some(k=>!Object.hasOwn(value,k))) return false;
      for (const [k,v] of Object.entries(value)) {
        if (!Object.hasOwn(rule.properties || {},k)) { if (rule.additionalProperties === false) return false; }
        else if (!check(rule.properties[k],v)) return false;
      }
    }
    return true;
  }
  need(Object.hasOwn(schema.$defs,name) && check(schema.$defs[name], value),400,`Invalid ${name}`);
  return value;
}
export function createV2Adapter({db,controller,checkout,config,options={},now=()=>Date.now()}) {
  const admin = {id:'operator',role:'operator'};
  const mode = config.PAYMENT_EVIDENCE_LEVEL === 'fixture' ? 'fixture' : 'sandbox';
  function validateCapability(cap,operation) {
    need(cap,403,'Room capability denied');
    validateWire('CapabilityRecord',cap);
    const time = now();
    need(cap.operations.includes(operation) && !cap.revoked_at && Date.parse(cap.expires_at)>time && Date.parse(cap.issued_at)<=time && Date.parse(cap.verified_at)<=time && time-Date.parse(cap.verified_at)<=60000,403,'Room capability expired, stale or revoked');
    need(operation!=='quote' || cap.job_id===null,403,'Job-scoped capability cannot issue another offer');
    const buyer=controller.principal(cap.buyer_id);
    need(buyer?.role==='buyer' && !buyer.revoked,403,'Verified buyer principal unavailable');
    return cap;
  }
  async function authorize(authority,operation) {
    need(typeof options.verifyCapability === 'function',503,'Current Rooms membership verifier unavailable');
    const cap = await options.verifyCapability(authority,{operation});
    return structuredClone(validateCapability(cap,operation));
  }
  function bound(q,cap) {
    const snapshot=JSON.parse(q.snapshot);
    need(snapshot.offer && q.buyer_id===cap.buyer_id && snapshot.offer.room_id===cap.room_id,403,'Quote room/buyer binding mismatch');
    return snapshot;
  }
  async function recheck(authority,operation,cap) {
    const current=await authorize(authority,operation);
    need(current.buyer_id===cap.buyer_id && current.room_id===cap.room_id && current.agent_id===cap.agent_id,403,'Membership changed during operation');
    return current;
  }
  // Lookup and validation are separate: every awaited membership check may
  // outlive an otherwise valid room proof. The final boundary check is synchronous.
  function validateReturnProof(cap,expected,proof,requireTrusted=false) {
    need(typeof expected==='string' && !/[\\\s]/.test(expected),400,'Invalid private return URL');
    let parsed;
    try {parsed=new URL(expected);} catch {throw problem(400,'Invalid private return URL');}
    need(parsed.origin===(options.roomsOrigin || 'https://rooms.wittlelabs.ai') && parsed.protocol==='https:' && !parsed.username && !parsed.password,403,'Private redirect origin denied');
    need(proof?.url===expected,403,'Private return proof mismatch');
    if (options.resolveRoomBinding !== undefined || requireTrusted || proof.binding) {
      need(typeof options.resolveRoomBinding==='function',503,'Trusted room binding resolver unavailable');
      const binding=proof.binding;
      need(binding,403,'Trusted room binding unavailable');
      validateWire('EntryResponse',binding);
      need(binding.room_id===cap.room_id && binding.mode===mode && Date.parse(binding.expires_at)>now(),403,'Room binding room, mode or expiry mismatch');
      need(binding.join_url===expected,403,'Private redirect differs from trusted room binding');
    } else {
      // Compatibility only: this cannot authorize an opaque entry/provider URL.
      need(parsed.pathname==='/r/'+cap.room_id && !parsed.search && !parsed.hash && parsed.href===expected,403,'Private redirect requires the trusted room binding');
    }
    return proof;
  }
  async function resolveReturn(cap,expected,requireTrusted=false) {
    let binding;
    if (options.resolveRoomBinding !== undefined || requireTrusted) {
      need(typeof options.resolveRoomBinding==='function',503,'Trusted room binding resolver unavailable');
      binding=await options.resolveRoomBinding(structuredClone(cap));
      need(binding,403,'Trusted room binding unavailable');
    }
    return validateReturnProof(cap,expected,{url:expected,...(binding ? {binding:structuredClone(binding)}:{})},requireTrusted);
  }
  function finalAuthority(cap,q,snapshot,proof) {
    validateCapability(cap,'quote');
    validateReturnProof(cap,snapshot.return_url,proof,!!snapshot.room_binding);
    if (snapshot.room_binding) validateReturnProof(cap,snapshot.return_url,{url:snapshot.return_url,binding:snapshot.room_binding},true);
    eligibleQuote(q);
  }
  function eligibleQuote(q) {
    const current=db.prepare('SELECT * FROM quotes WHERE id=?').get(q.id);
    need(current?.state==='active' && current.expires_at>now(),409,'Offer expired, cancelled or superseded');
    need(controller.principal(q.seller_id) && !controller.principal(q.seller_id).revoked,403,'Seller revoked');
    return current;
  }
  async function quote(authority,input) {
    validateWire('QuoteRequest',input);
    const cap=await authorize(authority,'quote');
    const fingerprint=hash(canonical(input));
    let q;
    const retry=db.prepare('SELECT * FROM v2_quote_requests WHERE buyer_id=? AND room_id=? AND request_id=?').get(cap.buyer_id,cap.room_id,input.request_id);
    if (retry) {
      need(retry.input_hash===fingerprint,409,'Retry key used for different scope');
      q=db.prepare('SELECT * FROM quotes WHERE id=?').get(retry.quote_id);
    } else {
      need(typeof options.getTerms==='function',503,'Saved scope and service terms unavailable');
      const terms=await options.getTerms(cap,structuredClone(input));
      const serviceRow=db.prepare('SELECT snapshot FROM services WHERE id=?').get(terms?.service_id);
      need(serviceRow,503,'Configured audit service unavailable');
      const service=JSON.parse(serviceRow.snapshot);
      need(service.prompt_version,503,'Immutable prompt version required');
      need(controller.principal(service.seller_id) && !controller.principal(service.seller_id).revoked,403,'Seller revoked');
      validateWire('Scope',terms.scope);
      need(canonical(terms.scope?.pages)===canonical(input.pages) && terms.scope?.site_url===input.site_url && terms.scope?.scope_summary===input.scope_summary && terms.scope?.findings_cap===input.findings_cap,409,'Saved scope differs from presented request');
      need(terms.scope.allowed_actions.every(a=>service.allowed_actions.includes(a)),403,'Scope exceeds service action policy');
      const expiry=Date.parse(terms.expires_at);
      need(Number.isFinite(expiry) && expiry>now() && expiry<=now()+30*86400000,400,'Invalid offer expiry');
      const redirect=await resolveReturn(cap,terms.return_url);
      const proposalCap=await recheck(authority,'quote',cap);
      validateCapability(proposalCap,'quote');
      validateReturnProof(proposalCap,terms.return_url,redirect);
      q=controller.transaction(()=> {
        // Another async caller may have completed while terms/membership were fetched.
        const concurrent=db.prepare('SELECT * FROM v2_quote_requests WHERE buyer_id=? AND room_id=? AND request_id=?').get(cap.buyer_id,cap.room_id,input.request_id);
        if(concurrent) {need(concurrent.input_hash===fingerprint,409,'Retry scope conflict');return db.prepare('SELECT * FROM quotes WHERE id=?').get(concurrent.quote_id);}
        const prior=db.prepare("SELECT * FROM quotes WHERE buyer_id=? AND state='active' ORDER BY rowid DESC").all(cap.buyer_id).find(row=>JSON.parse(row.snapshot).offer?.room_id===cap.room_id);
        if(prior) need(!db.prepare('SELECT id FROM orders WHERE quote_id=? AND payment_id IS NOT NULL').get(prior.id),409,'Paid scope cannot be superseded');
        const offer=validateWire('Offer',{schema_version:'wa-v2.1',buyer_id:cap.buyer_id,room_id:cap.room_id,seller_id:service.seller_id,service_id:service.id,service_version:service.service_version,provider:'whop',environment:'sandbox',company_id:service.account_id,product_id:service.product_id,plan_id:service.plan_id,currency:'USD',amount_minor:service.amount_minor,scope:terms.scope,expires_at:new Date(expiry).toISOString(),version:prior ? prior.version+1 : 1,supersedes:prior?.id || null});
        const snapshot={...service,buyer_id:cap.buyer_id,scope:offer.scope,expires_at:offer.expires_at,version:offer.version,supersedes:offer.supersedes,offer,return_url:redirect.url,...(redirect.binding ? {room_binding:redirect.binding}:{})};
        const id=randomUUID(),digest=hash(canonical(offer));
        if(prior) db.prepare("UPDATE quotes SET state='superseded' WHERE id=?").run(prior.id);
        db.prepare("INSERT INTO quotes VALUES (?,?,?,?,?,'active',?,?,?)").run(id,digest,cap.buyer_id,service.seller_id,canonical(snapshot),offer.version,expiry,'v2_'+randomUUID());
        db.prepare('INSERT INTO v2_quote_requests VALUES (?,?,?,?,?)').run(cap.buyer_id,cap.room_id,input.request_id,fingerprint,id);
        db.prepare('INSERT INTO payment_activity VALUES (?,?,?,?,?)').run('quote_'+id,'quote_issued',mode,new Date(now()).toISOString(),config.PAYMENT_EVIDENCE_LEVEL || 'local_execution');
        return db.prepare('SELECT * FROM quotes WHERE id=?').get(id);
      });
    }
    const snapshot=bound(q,cap);
    eligibleQuote(q); // Includes revoked sellers on recorded retry paths.
    const beforeProof=await resolveReturn(cap,snapshot.return_url,!!snapshot.room_binding);
    const beforeCap=await recheck(authority,'quote',cap);
    finalAuthority(beforeCap,q,snapshot,beforeProof); // No await before checkout effects.
    const order=await checkout(cap.buyer_id,'v2checkout_'+q.id,{row:q,snapshot});
    const afterProof=await resolveReturn(cap,snapshot.return_url,!!snapshot.room_binding);
    const afterCap=await recheck(authority,'quote',cap);
    finalAuthority(afterCap,q,snapshot,afterProof); // No await before releasing the URL.
    return validateWire('QuoteResponse',{quote_id:q.id,quote_hash:q.hash,checkout_url:order.purchase_url,expires_at:snapshot.offer.expires_at,offer:snapshot.offer,mode});
  }
  async function orderStatus(authority,input) {
    validateWire('OrderStatusRequest',input);
    const cap=await authorize(authority,'order_status');
    const q=db.prepare('SELECT * FROM quotes WHERE id=?').get(input.quote_id);
    need(q,404,'Quote not found');
    const snapshot=bound(q,cap),offer=snapshot.offer;
    const o=db.prepare('SELECT * FROM orders WHERE quote_id=?').get(q.id);
    need(cap.job_id===null || cap.job_id===o?.id,403,'Job capability binding mismatch');
    const receipt=o?.payment_id ? db.prepare('SELECT * FROM payment_receipts WHERE payment_id=?').get(o.payment_id) : null;
    const acceptance=o ? paymentAcceptance(o.id) : null;
    const workflow=o?.workflow_status;
    const held=workflow==='needs_attention' || workflow==='disputed';
    const inactive=q.state!=='active' || (!acceptance && q.expires_at<=now());
    const revisionRun=o && db.prepare("SELECT revision FROM runs WHERE order_id=? AND status='running'").get(o.id)?.revision===1;
    const state=held ? 'needs_attention' : inactive ? (o?.payment_id ? 'needs_attention':'cancelled') : ['delivered','revised','revision_pending'].includes(workflow) ? workflow : workflow==='running' ? (revisionRun?'revision_pending':'auditing') : acceptance ? 'paid_waiting':'quoted';
    const refund=receipt?.refunded_minor || 0;
    return validateWire('OrderStatus',{quote_id:q.id,quote_hash:q.hash,order_id:o?.id || null,state,payment_status:o?.payment_status==='failed' ? 'failed':o?.payment_id ? 'paid':'pending',refund_status:receipt?.refund_status || (refund ? (refund>=receipt.gross_minor ? 'full':'partial'):'none'),dispute_status:receipt?.dispute_status || (receipt?.state==='disputed' ? 'open':'none'),scope_summary:offer.scope.scope_summary,paid_at:acceptance?.accepted_at || null,reason:held ? (receipt?.state==='refunded' ? 'refund_requires_resolution':receipt?.state==='disputed' ? 'dispute_requires_resolution':'payment_requires_resolution') : inactive ? 'offer_'+(q.state==='active'?'expired':q.state) : acceptance ? (workflow==='paid_setup_pending'?'runtime_unavailable':workflow==='running'?null:workflow):null,updated_at:receipt?.at || new Date(now()).toISOString(),mode});
  }
  function paymentAcceptance(orderId) {
    const row=db.prepare('SELECT * FROM payment_acceptances WHERE order_id=?').get(orderId);
    return row ? validateWire('PaymentAcceptance',{...row}) : null;
  }
  function loadBinding(orderId) {
    const order=controller.viewOrder(admin,orderId),snapshot=order.quote_snapshot;
    need(snapshot?.offer,409,'Order is not a v2 offer');
    const q=db.prepare('SELECT state FROM quotes WHERE id=?').get(order.quote_id);
    return {order_id:order.id,quote_id:order.quote_id,quote_hash:order.quote_hash,offer:structuredClone(snapshot.offer),prompt_version:snapshot.prompt_version,acceptance:paymentAcceptance(orderId),quote_state:q.state,workflow_status:order.workflow_status,payment_status:order.payment_status};
  }
  return {quote,orderStatus,paymentAcceptance,loadBinding};
}
