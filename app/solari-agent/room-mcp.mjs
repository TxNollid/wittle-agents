import http from 'node:http';
import { randomBytes } from 'node:crypto';

// The owner/agent Rooms credential never enters a user session. The session
// receives only a short-lived proxy capability limited to its one room.
export async function roomMcp(roomId, upstreamToken, request = fetch) {
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.authorization!==`Bearer ${token}`)return send(401,{error:'Unauthorized'});
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)throw Error('Request too large');}
      const msg=JSON.parse(body);
      const allowed=['initialize','notifications/initialized','ping','tools/list','tools/call'];
      const fail=()=>send(200,{jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'This connection is limited to the current room.'}});
      if(!allowed.includes(msg.method))return fail();
      if(msg.method==='tools/call'){
        const {name,arguments:a={}}=msg.params || {};
        if(!['read_room','room','get_profile'].includes(name))return fail();
        if(name!=='get_profile' && a.room_id!==roomId)return fail();
        if(name==='room' && !['send','respond_to_event'].includes(a.action))return fail();
        if(name==='read_room' && !['get','events','brief'].includes(a.action))return fail();
      }
      const response=await request('https://rooms.wittlelabs.ai/mcp',{method:'POST',headers:{Authorization:`Bearer ${upstreamToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},body:JSON.stringify(msg),signal:AbortSignal.timeout(30000)});
      const text=await response.text();
      if(msg.method==='tools/list' && response.ok){
        const data=JSON.parse(text);if(data.result?.tools)data.result.tools=data.result.tools.filter(t=>['read_room','room','get_profile'].includes(t.name));
        return send(response.status,data);
      }
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type') || 'application/json'});res.end(text);
    }catch{send(502,{error:'Rooms connection failed'});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/mcp`,token,close:()=>new Promise(resolve=>server.close(resolve))};
}
