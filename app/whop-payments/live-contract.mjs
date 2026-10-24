// Provider contract probe only. Approval is a synthetic test fixture, not customer consent.
// Creates one unused sandbox checkout. Never submits a card or provisions Rooms.
import {loadConfig,makeClient,createService} from './server.mjs';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const config=loadConfig(),provider=makeClient(config),directory=mkdtempSync(join(tmpdir(),'wittle-whop-contract-'));
let providerResponse,submittedMetadata;
const client={checkoutConfigurations:{async create(input,options){submittedMetadata=input.metadata;providerResponse=await provider.checkoutConfigurations.create(input,options);return providerResponse;}},payments:provider.payments};
const s=createService(config,client,join(directory,'db.sqlite')),c=s.controller,admin={id:'operator',role:'operator'};
try{
 const buyer=c.register(admin,{id:'synthetic-buyer',role:'buyer',kind:'human'}),seller=c.register(admin,{id:'synthetic-seller',role:'seller',kind:'agent'});
 c.setService(admin,{id:'contract-test-v1',seller_id:seller.id,service_version:'sandbox-v1',account_id:config.WHOP_COMPANY_ID,product_id:config.WHOP_PRODUCT_ID,plan_id:config.WHOP_PLAN_ID,amount_minor:1000,currency:'usd',execution_cap_minor:100});
 const q=c.propose(seller,{service_id:'contract-test-v1',buyer_id:buyer.id,request_id:randomUUID(),expires_at:new Date(Date.now()+3600000).toISOString(),scope:{title:'Automated sandbox API contract probe',deliverables:['Verify checkout creation accepts quote binding metadata'],acceptance_checks:['Whop returns a sandbox checkout ID'],exclusions:['No payment','No actual delivery'],required_inputs:[],revisions:0,refund_terms:'No funds submitted',delivery_timing:'Contract probe only',permitted_recipients:[],allowed_actions:[]}});
 c.approve(buyer,q.id,{quote_hash:q.hash,expected_version:q.version});
 const binding=c.checkoutBinding(buyer,{quote_id:q.id,quote_hash:q.hash});
 const order=await s.checkout(buyer.id,randomUUID(),binding);
 const metadataVisible=providerResponse.metadata!==null&&providerResponse.metadata!==undefined;
 const report={checked_at:new Date().toISOString(),environment:'Whop sandbox',approval_source:'synthetic test fixture; not a customer approval',submitted_payment:false,created_real_rooms_project:false,provider_checkout_id:order.checkout_id,provider_account_matches:providerResponse.account_id===config.WHOP_COMPANY_ID,submitted_metadata_keys:Object.keys(submittedMetadata),metadata_echo_visible:metadataVisible,metadata_echo_matches:metadataVisible?Object.keys(submittedMetadata).every(k=>providerResponse.metadata[k]===submittedMetadata[k]):null,note:metadataVisible?'Metadata echoed and compared':'Current key lacks checkout_configuration:basic:read; metadata acceptance was tested but echo is hidden. Authoritative payment metadata remains to be tested with a completed purchase.'};
 writeFileSync(new URL('../../sandbox/whop-live-contract.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{s.close();rmSync(directory,{recursive:true});}
