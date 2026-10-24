// Presentation only: persisted brief and agreement hashes remain unchanged.
const labels={site_url:'Website',pages:'Pages to review',excluded_pages:'Excluded pages',goal:'Goal',constraints:'Constraints',scope_summary:'Scope',findings_cap:'Maximum findings'};
export function formatConciergeMessage(text){
 if(typeof text!=='string')throw Error('INVALID_CONCIERGE_MESSAGE');
 return text.replace(/^(Host:\s*)+/,'Host: ').replace(/^Scope draft: (\{[^\n]*\})$/m,(_,json)=>{
  const brief=JSON.parse(json);
  if(!brief||Array.isArray(brief)||Object.keys(brief).some(key=>!Object.hasOwn(labels,key)))throw Error('INVALID_SCOPE_PRESENTATION');
  const lines=Object.entries(brief).map(([key,value])=>{
   if(Array.isArray(value)){
    if(value.some(item=>typeof item!=='string'))throw Error('INVALID_SCOPE_PRESENTATION');
    return value.length?`${labels[key]}:\n${value.map(item=>`  - ${item}`).join('\n')}`:`${labels[key]}: None`;
   }
   if(typeof value!=='string'&&typeof value!=='number')throw Error('INVALID_SCOPE_PRESENTATION');
   return `${labels[key]}: ${value}`;
  });
  return `Scope so far:\n${lines.join('\n')}`;
 });
}
