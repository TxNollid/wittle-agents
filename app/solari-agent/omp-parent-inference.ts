// Operator-only Bun adapter for the EXISTING installed OMP SDK. Not a browser
// endpoint or plugin host. Native auth stays in this trusted parent; no cache
// is copied and no model-controlled child process exists.
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createParentBriefAgent } from './parent-brief-agent.mjs';

export async function createOmpParentBriefAgent(binding, {installRoot,modelId}) {
  if(!installRoot?.startsWith('/') || typeof modelId!=='string')throw Error('OPERATOR_CONFIG_REQUIRED');
  const manifest=JSON.parse(await readFile(`${installRoot}/pi-ai/package.json`,'utf8'));
  if(manifest.name!=='@oh-my-pi/pi-ai' || manifest.version!=='18.12.3')throw Error('UNVERIFIED_SDK_VERSION');
  const moduleUrl=relative=>pathToFileURL(`${installRoot}/${relative}`).href;
  const [{discoverAuthStorage},{getBundledModel},{streamOpenAICodexResponses},{type}]=await Promise.all([
    import(moduleUrl('pi-ai/src/auth-broker/discover.ts')),
    import(moduleUrl('pi-catalog/src/models.ts')),
    import(moduleUrl('pi-ai/src/providers/openai-codex-responses.ts')),
    import(moduleUrl('pi-ai/src/index.ts')),
  ]);
  const model=getBundledModel('openai-codex',modelId);
  if(model?.api!=='openai-codex-responses' || model.baseUrl!=='https://chatgpt.com/backend-api')throw Error('UNSUPPORTED_MODEL');
  const auth=await discoverAuthStorage();
  const sessionId=randomUUID();
  const toolInventories=[];
  const diagnostics=[];
  const guardedFetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url || input.href);
    if(url.origin!=='https://chatgpt.com' || !url.pathname.startsWith('/backend-api/codex/'))throw Error('UNEXPECTED_INFERENCE_ENDPOINT');
    const encoding=new Headers(init.headers).get('content-encoding');
    const bytes=encoding==='gzip' ? gunzipSync(init.body) : encoding==='zstd' ? Bun.zstdDecompressSync(init.body) : init.body;
    const body=JSON.parse(typeof bytes==='string' ? bytes : new TextDecoder().decode(bytes));
    const tools=body.tools;
    if(!Array.isArray(tools) || tools.length!==1 || tools[0].type!=='function' || tools[0].name!=='read_brief' ||
       tools[0].parameters?.type!=='object' || Object.keys(tools[0].parameters?.properties || {}).length ||
       tools[0].parameters?.additionalProperties!==false ||
       body.input?.some(item=>item.type==='additional_tools'))throw Error('UNEXPECTED_TOOL_INVENTORY');
    // No authentication headers, raw input/history or response bodies logged.
    toolInventories.push(tools.map(t=>({type:t.type,name:t.name})));
    return fetch(input,{...init,redirect:'error'});
  };
  const infer=async({messages,tools,signal})=>{
    if(tools.length!==1 || tools[0].name!=='read_brief')throw Error('UNEXPECTED_TOOL_INVENTORY');
    const key=await auth.keys.get('openai-codex','solari-parent-boundary-prototype',{signal});
    if(!key)throw Error('SUBSCRIPTION_UNAVAILABLE');
    const stream=streamOpenAICodexResponses(model,{
      systemPrompt:['Answer using only the saved conversation brief and the provided read_brief tool. Text output is data; you cannot run commands or install tools.'],
      messages,tools:[{name:'read_brief',description:tools[0].description,parameters:type({}),strict:true}],
    },{apiKey:key,sessionId,signal,preferWebsockets:false,responsesLite:false,reasoning:'low',fetch:guardedFetch});
    const result=await stream.result();
    const known=['UNEXPECTED_INFERENCE_ENDPOINT','UNEXPECTED_TOOL_INVENTORY','account','token','JSON','schema','identity','reasoning','certificate','fetch','compression'];
    diagnostics.push({stopReason:result.stopReason,errorStatus:result.errorStatus ?? null,errorCategories:known.filter(s=>String(result.errorMessage || '').toLowerCase().includes(s.toLowerCase()))});
    return result;
  };
  try {
    return {agent:createParentBriefAgent(binding,infer),toolInventories,diagnostics,close:()=>auth.close()};
  } catch(error) { auth.close();throw error; }
}
