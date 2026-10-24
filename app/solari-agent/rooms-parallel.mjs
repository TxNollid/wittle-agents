import { Relay, mcp, loadJson, saveJson } from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/core.mjs';
import { createAuth } from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/auth.mjs';
import { appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Sessions } from './sessions.mjs';
import { runCodexAgent, executeCodex } from './server.mjs';
import { roomMcp } from './room-mcp.mjs';
import { assertTrustedDevelopment, assertTrustedRoom } from './execution-policy.mjs';

assertTrustedDevelopment(process.env);
const home='/work/rooms-relay';
const config=JSON.parse(await readFile(`${home}/config.json`,'utf8'));
const sessions=new Sessions(process.env);
await sessions.init();
const auth=createAuth({server:config.server,dir:home,clientId:config.client_id});
const controller=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>controller.abort());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

class ParallelRelay extends Relay {
  async watch(agent,signal){
    // Cursor and pending records are retained from the official relay state.
    // Each event gets an independent chat lock; different rooms can progress
    // while this agent's inbox wait remains active.
    let pending=[...(agent.pending || [])];
    let cursor=agent.cursor;
    const running=new Set();
    const persist=()=>this.update(agent.name,{cursor,pending,state:running.size?'running':'waiting',active_runs:running.size});
    const launch=wake=>{
      const job=(async()=>{
        const runId=randomUUID(),started=new Date().toISOString();let exitCode=1;
        try{
          if(!wake.event.room_id)throw Error('Only admitted room messages run on this hosted chat agent.');
          assertTrustedRoom(process.env,wake.event.room_id);
          const token=await this.token(agent);
          const roomId=wake.event.room_id;
          const task=`Use rooms_relay to read room ${roomId}, then handle this source event within the room's goal. Reply at most once in that same room when useful. Never respond to your own message. Source event: ${JSON.stringify(wake.event)}`;
          await sessions.run(`room:${roomId}`,task,async context=>{
            // A separate proxy limits this child to this room even though the
            // supervisor's upstream relay token can cover several rooms.
            const proxy=await roomMcp(roomId,token);
            try{return await runCodexAgent(task,{...process.env,CODEX_HOME:context.codexHome,CODEX_WORKSPACE:context.workspace,RUN_HOME:context.home,RUN_TMP:context.temp,EXEC_UID:context.uid,EXEC_GID:context.gid,ROOMS_MCP_URL:proxy.url,ROOMS_SESSION_TOKEN:proxy.token},executeCodex,context);}
            finally{await proxy.close();}
          });
          exitCode=0;
        }catch(error){await this.update(agent.name,{last_error:{at:new Date().toISOString(),message:String(error.message).slice(0,300)}});}
        finally{
          const ended=new Date().toISOString();
          await appendFile(this.wakesPath,JSON.stringify({agent:agent.name,wait_event_ids:[wake.event.message_id || wake.event.event_id || wake.event.item_id],room_id:wake.event.room_id || null,room_positions:wake.room_position===null?[]:[wake.room_position],cursor_before:wake.cursor_before,cursor_after:wake.cursor_after,run_id:runId,started,ended,exit_code:exitCode})+'\n',{mode:0o600});
          pending=pending.filter(p=>p!==wake);
          await this.update(agent.name,{last_run:{run_id:runId,started,ended,exit_code:exitCode},...(exitCode===0?{last_error:null}:{})});
        }
      })();
      running.add(job);
      job.finally(()=>{running.delete(job);persist().catch(()=>{});});
    };
    for(const wake of pending)launch(wake);
    try{
      while(!signal.aborted && agent.active){
        try{
          const token=await this.token(agent);
          const result=await mcp(this.server,token,'read_inbox',{action:'wait',timeout_seconds:25,...(cursor?{cursor}:{})},signal);
          if(!result.cursor)throw Error('Wait returned no cursor');
          const batch=[];
          for(const event of result.events || []){
            // Joins/closure notices do not run user tasks; an explicit source
            // message is required. Preserve inbox position for other notices.
            if(!event.room_id || !event.message_id)continue;
            batch.push({event,cursor_before:cursor,cursor_after:result.cursor,room_position:await this.position(token,event)});
          }
          cursor=result.cursor;pending.push(...batch);
          await persist(); // persist before launch; crash may retry source IDs
          for(const wake of batch)launch(wake);
          if(batch.length)await this.update(agent.name,{last_wake:new Date().toISOString()});
        }catch(error){
          if(signal.aborted)break;
          await this.update(agent.name,{last_error:{message:String(error.message).slice(0,200),at:new Date().toISOString()}});
          if(error.status===401 || error.status===403)break;
          await sleep(5000);
        }
      }
    }finally{await Promise.allSettled([...running]);}
  }
}
const pidFile=`${home}/daemon.json`;
const previous=await loadJson(pidFile,null);
if(previous){try{process.kill(previous.pid,0);throw Error('Relay is already running');}catch(e){if(e.code!=='ESRCH')throw e;}}
await writeFile(pidFile,JSON.stringify({pid:process.pid})+'\n',{mode:0o600});
const relay=new ParallelRelay({server:config.server,dir:home,auth});
for(const agent of await relay.agents())if(agent.last_run?.exit_code===0)await relay.update(agent.name,{last_error:null});
try{await relay.start(controller.signal);}finally{await unlink(pidFile).catch(()=>{});}
