import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from './server.mjs';

const config = { WHOP_COMPANY_ID:'biz_test', WHOP_PRODUCT_ID:'prod_test', WHOP_PLAN_ID:'plan_test', WHOP_PRICE:'10.00', WHOP_WEBHOOK_SECRET:'ws_test_secret', PAYMENTS_SERVICE_TOKEN:'private-test-token', APP_URL:'http://localhost:3210' };
export async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'wittle-payment-audit-'));
  let creates=0, retrieves=0;
  const payments=new Map();
  const client={checkoutConfigurations:{async create(){creates++;return {id:'ch_'+randomUUID().replaceAll('-',''),purchase_url:'https://sandbox.whop.com/checkout/test/'};}},payments:{async retrieve({id}){retrieves++; if(!payments.has(id)) throw new Error('Temporarily unavailable'); return payments.get(id);}}};
  const path=join(directory,'db.sqlite');
  const service=createService(config,client,path);
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+service.server.address().port;
  const call=async(path,body,auth='Bearer '+config.PAYMENTS_SERVICE_TOKEN)=>{
    const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const order=await service.checkout('buyer-a','request-'+randomUUID());
  const payment={id:'pay_'+randomUUID().replaceAll('-',''),account_id:config.WHOP_COMPANY_ID,product_id:config.WHOP_PRODUCT_ID,plan_id:config.WHOP_PLAN_ID,checkout_configuration_id:order.checkout_id,metadata:{order_id:order.id,environment:'sandbox'},currency:'usd',subtotal:{amount:'10.00',currency:'usd'},total:{amount:'10.00',currency:'usd'},status:'paid',substatus:'succeeded'};
  payments.set(payment.id,payment);
  const event=(type='payment.succeeded',extra={})=>({id:'msg_'+randomUUID(),type,account_id:config.WHOP_COMPANY_ID,data:structuredClone(payment),...extra});
  const post=async(e,{timestamp=Math.floor(Date.now()/1000),raw=JSON.stringify(e),headerId=e.id}={})=>{
    const signature=createHmac('sha256',config.WHOP_WEBHOOK_SECRET).update(headerId+'.'+timestamp+'.'+raw).digest('base64');
    const r=await fetch(url+'/api/webhooks/whop',{method:'POST',body:raw,headers:{'Content-Type':'application/json','webhook-id':headerId,'webhook-timestamp':String(timestamp),'webhook-signature':'v1,'+signature}});
    return {status:r.status,body:await r.json()};
  };
  const rows=table=>service.db.prepare(`SELECT * FROM ${table}`).all();
  t.after(async()=>{await new Promise(r=>service.server.close(r)); service.close();rmSync(directory,{recursive:true});});
  return {...service,config,client,path,url,call,order,payment,payments,event,post,rows,counts:()=>({creates,retrieves})};
}

test('same request key from another buyer during an in-flight checkout cannot disclose first buyer order',async t=>{
  const f=await fixture(t);let release;const wait=new Promise(r=>release=r);
  const original=f.client.checkoutConfigurations.create;
  f.client.checkoutConfigurations.create=async(...args)=>{await wait;return original(...args);};
  const first=f.checkout('buyer-a','concurrent-key');
  const second=f.checkout('buyer-b','concurrent-key');
  const rejected=assert.rejects(second,{status:409}); release(); await first; await rejected;
});
test('concurrent retries by the same buyer create one checkout',async t=>{
  const f=await fixture(t);const before=f.counts().creates;
  const orders=await Promise.all(Array.from({length:20},()=>f.checkout('buyer-a','same-request')));
  assert.equal(new Set(orders.map(x=>x.id)).size,1);assert.equal(f.counts().creates-before,1);
});
test('bare token and wrong auth schemes are rejected',async t=>{
  const f=await fixture(t);
  for(const auth of [config.PAYMENTS_SERVICE_TOKEN,'Basic '+config.PAYMENTS_SERVICE_TOKEN,'Bearer wrong','']) assert.equal((await f.call('/api/orders/'+f.order.id,undefined,auth)).status,401);
});
test('valid internal Bearer token can read its order; unknown order is 404',async t=>{
  const f=await fixture(t);assert.equal((await f.call('/api/orders/'+f.order.id)).status,200);assert.equal((await f.call('/api/orders/'+randomUUID())).status,404);
});
test('malformed JSON and null request bodies return 400',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/checkout',null)).status,400);
  const r=await fetch(f.url+'/api/checkout',{method:'POST',headers:{Authorization:'Bearer '+config.PAYMENTS_SERVICE_TOKEN},body:'{'});assert.equal(r.status,400);
});
test('missing buyer, oversized buyer and invalid request keys are rejected',async t=>{
  const f=await fixture(t);
  for(const [buyer,key] of [[null,'valid-key'],['x'.repeat(201),'valid-key'],['buyer','bad'],['buyer',{}],['buyer','a'.repeat(101)]]) await assert.rejects(f.checkout(buyer,key),{status:400});
});
for(const [name,change] of Object.entries({
  'wrong seller account':p=>p.account_id='biz_other', 'wrong product':p=>p.product_id='prod_other', 'wrong plan':p=>p.plan_id='plan_other',
  'wrong checkout':p=>p.checkout_configuration_id='ch_other', 'wrong environment':p=>p.metadata.environment='production', 'wrong currency':p=>p.currency='eur',
  'missing order metadata':p=>p.metadata={}, 'underpayment':p=>p.subtotal.amount='9.99', 'overpayment':p=>p.subtotal.amount='10.01',
  'negative amount':p=>p.subtotal.amount='-10.00', 'excess precision':p=>p.subtotal.amount='10.001', 'total below quoted subtotal':p=>p.total.amount='9.99',
  'refund timestamp':p=>p.refunded_at='2026-10-24', 'partial refund':p=>p.refunded_amount={amount:'1.00',currency:'usd'}, 'dispute':p=>p.substatus='disputed',
  'different API payment ID':p=>p.id='pay_other',
})) test(name+' cannot create a receipt',async t=>{const f=await fixture(t);change(f.payment);await assert.rejects(f.reconcile([...f.payments.keys()][0]),{status:422});assert.equal(f.rows('fulfillments').length,0);});
for(const status of ['open','pending','void','uncollectible']) test(status+' payment cannot unlock work',async t=>{const f=await fixture(t);f.payment.status=status;await f.reconcile(f.payment.id);assert.equal(f.rows('fulfillments').length,0);});
test('tax-inclusive total above subtotal is accepted without confusing fees with quoted price',async t=>{const f=await fixture(t);f.payment.total.amount='10.89';await f.reconcile(f.payment.id);assert.equal(f.rows('fulfillments').length,1);});
test('duplicate successes and delayed failure events cannot duplicate or downgrade a paid order',async t=>{
  const f=await fixture(t);const success=f.event();await f.post(success);await f.post(success);await f.drain();
  await f.post(f.event('payment.failed'));await f.drain();assert.equal(f.rows('fulfillments').length,1);assert.equal(f.rows('orders')[0].status,'paid');
});
test('legacy webhook envelope reconciles through current payment API',async t=>{
  const f=await fixture(t);const e=f.event();delete e.account_id;e.data.company={id:config.WHOP_COMPANY_ID};delete e.data.account_id;await f.post(e);await f.drain();assert.equal(f.rows('fulfillments').length,1);
});
test('wrong webhook account is durably rejected',async t=>{const f=await fixture(t);await f.post(f.event('payment.succeeded',{account_id:'biz_other'}));await f.drain();assert.equal(f.rows('events')[0].status,'rejected');assert.equal(f.rows('fulfillments').length,0);});
test('browser redirect and client paid=true never confirm payment',async t=>{
  const f=await fixture(t);await f.call('/checkout-complete?paid=true');await f.call('/api/orders/'+f.order.id+'/confirm',{paid:true,payment_id:'pay_missing'});assert.equal(f.rows('orders')[0].status,'pending');assert.equal(f.rows('fulfillments').length,0);
});
test('signed event with header/body ID mismatch is rejected',async t=>{const f=await fixture(t);assert.equal((await f.post(f.event(),{headerId:'msg_another'})).status,400);assert.equal(f.rows('events').length,0);});
test('signed malformed event body is rejected',async t=>{const f=await fixture(t);assert.equal((await f.post({id:'msg_bad',type:'payment.succeeded'})).status,400);});
test('payment API outage retries from durable queue after database reopen',async t=>{
  const f=await fixture(t);const original=f.client.payments.retrieve;f.client.payments.retrieve=async()=>{throw new Error('outage');};await f.post(f.event());await f.drain();
  assert.equal(f.rows('events')[0].status,'pending');assert.equal(f.rows('fulfillments').length,0);
  f.client.payments.retrieve=original;f.db.prepare('UPDATE events SET retry_at=0').run();
  const reopened=createService(config,f.client,f.path);await reopened.drain();assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM fulfillments').get().n,1);reopened.close();
});
test('duplicate distinct successful payments on one order require reconciliation',async t=>{
  const f=await fixture(t);await f.reconcile(f.payment.id);const other={...f.payment,id:'pay_second'};f.payments.set(other.id,other);await assert.rejects(f.reconcile(other.id),{status:409});assert.equal(f.rows('fulfillments').length,1);
});
test('live Whop sample without a local order is acknowledged and cannot provision work',async t=>{
  const f=await fixture(t);await f.post(f.event('payment.succeeded',{account_id:'biz_xxxxxxxxxxxxxx',data:{id:'pay_sample',metadata:{}}}));await f.drain();assert.equal(f.rows('events')[0].status,'processed');assert.equal(f.rows('fulfillments').length,0);
});
test('signed Unicode payload stays byte-exact across HTTP chunk boundaries',async t=>{
  const f=await fixture(t),event=f.event('payment.succeeded',{data:{id:'pay_sample',metadata:{note:'Scope 🌱 café'}}}),raw=JSON.stringify(event),bytes=Buffer.from(raw),timestamp=Math.floor(Date.now()/1000),split=bytes.indexOf(Buffer.from('🌱'))+1;
  const signature=createHmac('sha256',config.WHOP_WEBHOOK_SECRET).update(event.id+'.'+timestamp+'.'+raw).digest('base64');
  const {request}=await import('node:http');
  const status=await new Promise((resolve,reject)=>{const req=request(f.url+'/api/webhooks/whop',{method:'POST',headers:{'webhook-id':event.id,'webhook-timestamp':String(timestamp),'webhook-signature':'v1,'+signature}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),5);});
  assert.equal(status,200);
});
