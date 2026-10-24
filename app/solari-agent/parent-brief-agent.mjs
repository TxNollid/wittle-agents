// Bounded prototype only. This module does not import fs, child_process, an
// agent runtime, MCP, plugins, eval, or a credential provider. Inference is a
// trusted-host dependency; only validated read_brief({}) proposals execute here.
export const BRIEF_TOOL = Object.freeze({
  name:'read_brief', description:'Read the saved brief for this conversation.',
  parameters:{type:'object',properties:{},required:[],additionalProperties:false},
});

function fail(code) { const e = new Error(code); e.code=code; return e; }
export function createParentBriefAgent({buyer_id,room_id,brief}, infer) {
  if (![buyer_id,room_id].every(x=>typeof x==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(x)) ||
      typeof brief!=='string' || brief.length>4000 || typeof infer!=='function') throw fail('INVALID_BINDING');
  // Capture only explicit nonsecret server-owned data, never request objects,
  // config/env, capabilities, tool implementations or credentials.
  const snapshot=JSON.stringify({buyer_id,room_id,brief});
  let busy=false;
  return Object.freeze({
    async run(task) {
      if(typeof task!=='string' || !task.trim() || task.length>8000)throw fail('INVALID_TASK');
      if(busy)throw fail('BUSY');
      busy=true;
      const deadline=AbortSignal.timeout(45_000);
      const messages=[{role:'user',content:task,timestamp:Date.now()}];
      const trace=[];
      try {
        for(let step=0;step<4;step++) {
          deadline.throwIfAborted();
          const answer=await infer({messages:structuredClone(messages),tools:[structuredClone(BRIEF_TOOL)],signal:deadline});
          if(!answer || answer.role!=='assistant' || !Array.isArray(answer.content) || !['stop','toolUse'].includes(answer.stopReason))throw fail('INFERENCE_UNAVAILABLE');
          const calls=answer.content.filter(p=>p.type==='toolCall');
          if(answer.content.some(p=>!['text','thinking','toolCall'].includes(p.type)) || calls.length>1)throw fail('INVALID_MODEL_OUTPUT');
          // Validate the entire proposal before effects. Unknown tools never get
          // reflected into another model request or dispatched through a registry.
          for(const call of calls) {
            if(call.name!=='read_brief' || typeof call.id!=='string' || !call.arguments ||
               typeof call.arguments!=='object' || Array.isArray(call.arguments) || Object.keys(call.arguments).length)throw fail('TOOL_DENIED');
          }
          if(!calls.length) {
            const output=answer.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
            if(typeof output!=='string' || !output.trim() || output.length>8000)throw fail('INVALID_MODEL_OUTPUT');
            return {output,trace,room_id,buyer_id,prototype:true};
          }
          messages.push(answer);
          messages.push({role:'toolResult',toolCallId:calls[0].id,toolName:'read_brief',content:[{type:'text',text:snapshot}],isError:false,timestamp:Date.now()});
          trace.push({tool:'read_brief'});
        }
        throw fail('STEP_LIMIT');
      } finally {busy=false;}
    },
  });
}
