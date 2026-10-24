// Trusted backend only. Solari and transport credentials stay in this closure;
// none are returned as browser/model capabilities or bundled into room data.
import {readFile} from 'node:fs/promises';
export async function createConciergeSolariClient({solariApiKey,statePath=new URL('../../.solari/concierge.json',import.meta.url),request=fetch}) {
 if(typeof solariApiKey!=='string'||!solariApiKey)throw Error('SOLARI_BACKEND_CREDENTIAL_REQUIRED');
 const state=JSON.parse(await readFile(statePath,'utf8'));
 if(state.identity?.account!=='@concierge'||!state.testRoomBinding?.room_id||!state.transportToken)throw Error('CONCIERGE_TRANSPORT_NOT_BOUND');
 const base=`https://api.getsolari.com/sandboxes/${encodeURIComponent(state.sandboxId)}`;
 async function runtime({signal}={}){
  const result=await request(base,{headers:{Authorization:`Bearer ${solariApiKey}`},signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),redirect:'error'});
  if(!result.ok)throw Error('SOLARI_RUNTIME_UNAVAILABLE');
  const value=await result.json();
  if(value.state!=='running'||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now())throw Error('SOLARI_RUNTIME_UNAVAILABLE');
  return {state:value.state,expires_at:value.expiresAt,observed_at:new Date().toISOString()};
 }
 async function invoke(path,body,{signal}={}){
  const tunnel=await request(base+'/tunnel',{headers:{Authorization:`Bearer ${solariApiKey}`},signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),redirect:'error'});
  if(!tunnel.ok)throw Error('SOLARI_TUNNEL_UNAVAILABLE');
  const connection=await tunnel.json();
  const origin=new URL(connection.urlTemplate.replace('{port}','3010'));
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.preview.getsolari.com'))throw Error('INVALID_TRANSPORT_ORIGIN');
  const result=await request(new URL(path,origin),{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${state.transportToken}`,'x-solari-preview-token':connection.authToken,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),redirect:'error'});
  if(!result.ok)throw Object.assign(new Error('CONCIERGE_TRANSPORT_UNAVAILABLE'),{status:result.status});
  return result.json();
 }
 return Object.freeze({binding:structuredClone(state.testRoomBinding),runtime,health:options=>invoke('/health',undefined,options),readRoom:options=>invoke('/read-room',{},options),readEvents:({cursor=0,limit=100,signal}={})=>invoke('/read-events',{cursor,limit},{signal}),send:(input,options)=>invoke('/send',input,options),wakeEvents:options=>invoke('/wake-events',undefined,options),ackWake:(event_id,options)=>invoke('/ack-wake',{event_id},options)});
}
