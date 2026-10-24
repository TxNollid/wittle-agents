// Real sandbox provider wiring for the dashboard-verified USD19 one-time offer.
// Trusted backend only: returned config contains credentials and must never be serialized.
import {loadConfig,makeClient} from './server.mjs';
export const auditSandboxCatalog=Object.freeze({account_id:'biz_IjJuLR3B2vaFYr',product_id:'prod_WBl6tdbNytNY9',plan_id:'plan_GEPhNP465uxdX',amount_minor:1900,currency:'usd',environment:'sandbox'});
export function makeAuditSandboxPayment() {
 const saved=loadConfig();
 if(saved.WHOP_COMPANY_ID!==auditSandboxCatalog.account_id || saved.WHOP_SANDBOX!=='true')throw new Error('Verified sandbox business required');
 const config={...saved,WHOP_PRODUCT_ID:auditSandboxCatalog.product_id,WHOP_PLAN_ID:auditSandboxCatalog.plan_id,WHOP_PRICE:'19.00',PAYMENT_EVIDENCE_LEVEL:'provider'};
 return {config,client:makeClient(config)};
}
