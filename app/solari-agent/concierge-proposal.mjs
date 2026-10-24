// Null means unanswered, never an explicit empty constraint/exclusion list.
// Unknown non-null fields still reach the host's strict validator and fail.
export function normalizeConciergeProposal(proposal){
 const result=structuredClone(proposal);
 result.brief_update=Object.fromEntries(Object.entries(result.brief_update).filter(([,value])=>value!==null));
 const site=result.brief_update.site_url;
 if(typeof site==='string'&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\/?$/i.test(site))result.brief_update.site_url=`https://${site}`;
 return result;
}

// Closed list, checked by the trusted supervisor, not model-declared consent.
export function isExplicitScopeAgreement(text){
 return typeof text==='string'&&/^(?:yes[.!]?|yes, that scope is correct\. please finalize the brief\.)$/i.test(text.trim());
}
