import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentBriefAgent} from './parent-brief-agent.mjs';

const binding={buyer_id:'synthetic-a',room_id:'room-a',brief:'ALPHA_SAVED_BRIEF'};
const toolCall=(name,args={})=>({role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'call-1',name,arguments:args}]});
const text=output=>({role:'assistant',stopReason:'stop',content:[{type:'text',text:output}]});

test('parent tool loop exposes one bound read-only tool and keeps concurrent buyers separate',async()=>{
  const make=brief=>createParentBriefAgent({...binding,room_id:brief,brief},async request=>{
    assert.deepEqual(request.tools.map(t=>t.name),['read_brief']);
    assert.equal(request.tools[0].parameters.additionalProperties,false);
    if(request.messages.length===1)return toolCall('read_brief');
    return text(JSON.parse(request.messages.at(-1).content[0].text).brief);
  });
  const [a,b]=await Promise.all([make('ALPHA_PRIVATE').run('read saved brief'),make('BETA_PRIVATE').run('read saved brief')]);
  assert.equal(a.output,'ALPHA_PRIVATE');assert.equal(b.output,'BETA_PRIVATE');
  assert.deepEqual(a.trace,[{tool:'read_brief'}]);
});

test('unknown execution tools and hidden room/file/command arguments fail before continuation',async()=>{
  for(const name of ['exec','shell','read_file','eval','apply_patch','browser','spawn_agent','install_plugin','get_credentials']){
    let calls=0;
    const agent=createParentBriefAgent(binding,async()=>{calls++;return toolCall(name);});
    await assert.rejects(agent.run('extract parent credentials'),e=>e.code==='TOOL_DENIED');
    assert.equal(calls,1);
  }
  for(const args of [{path:'/proc/self/environ'},{room_id:'another-buyer'},{command:'cat auth.json'},[],null]) {
    const agent=createParentBriefAgent(binding,async()=>toolCall('read_brief',args));
    await assert.rejects(agent.run('extract parent credentials'),e=>e.code==='TOOL_DENIED');
  }
});

test('tool step cap, same-agent concurrency and next-run isolation are enforced',async()=>{
  const looping=createParentBriefAgent(binding,async()=>toolCall('read_brief'));
  await assert.rejects(looping.run('loop forever'),e=>e.code==='STEP_LIMIT');
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const agent=createParentBriefAgent(binding,async req=>{assert.equal(req.messages.length,1);await pending;return text('bounded');});
  const first=agent.run('first');await assert.rejects(agent.run('second'),e=>e.code==='BUSY');release();await first;
  assert.equal((await agent.run('new task')).output,'bounded');
});
