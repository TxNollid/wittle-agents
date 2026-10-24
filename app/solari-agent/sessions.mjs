import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, open, unlink, chmod, chown, cp, access, rename, lstat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { assertTrustedDevelopment } from './execution-policy.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function json(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if(e.code === 'ENOENT') return fallback; throw e; } }
export async function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export async function lock(path, operation, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { const file = await open(path, 'wx', 0o600); await file.writeFile(String(process.pid)); await file.close(); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const pid = Number(await readFile(path, 'utf8')); try { process.kill(pid, 0); } catch (e) { if(e.code === 'ESRCH') { await unlink(path).catch(()=>{}); continue; } } } catch {}
      if (Date.now() > deadline) { const e = new Error('This chat is still busy; retry later.'); e.status = 429; throw e; }
      await sleep(50);
    }
  }
  try { return await operation(); } finally { await unlink(path).catch(()=>{}); }
}

export class Sessions {
  constructor(config = {}, provision = provisionLinuxUser) {
    this.config = config;
    this.root = config.SESSION_STATE_DIR || '/work/agent-state';
    this.workRoot = config.SESSION_WORK_DIR || '/work/agent-sessions';
    this.instructions = config.AGENT_INSTRUCTIONS_FILE || new URL('./instructions/AGENTS.md', import.meta.url);
    this.max = Number(config.MAX_CONCURRENT_RUNS || 2);
    if (!Number.isInteger(this.max) || this.max < 1 || this.max > 8) throw new Error('MAX_CONCURRENT_RUNS must be 1–8.');
    this.provision = provision;
  }
  async init() {
    await mkdir(this.root, { recursive:true, mode:0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.workRoot, {recursive:true, mode:0o711});
    await chmod(this.workRoot, 0o711);
  }
  async create(label = '') {
    assertTrustedDevelopment(this.config);
    await this.init();
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    await save(join(this.root, `session-${id}.json`), { id, label: String(label).slice(0,100), tokenHash:digest(token) });
    return { id, token };
  }
  async authorize(id, token) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return false;
    const session = await json(join(this.root, `session-${id}.json`), null);
    return Boolean(session && timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(digest(token))));
  }
  async run(key, task, operation) {
    assertTrustedDevelopment(this.config);
    await this.init();
    const id = digest(key);
    return lock(join(this.root, `chat-${id}.lock`), async () => {
      let slot;
      const deadline = Date.now() + 240_000;
      while (slot === undefined) {
        for(let i=0;i<this.max;i++) {
          const path = join(this.root, `slot-${i}.lock`);
          try { const f = await open(path,'wx',0o600); await f.writeFile(String(process.pid)); await f.close(); slot=path; break; }
          catch(e) { if(e.code!=='EEXIST') throw e; try { const pid=Number(await readFile(path,'utf8')); try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')await unlink(path).catch(()=>{});} }catch{} }
        }
        if(slot === undefined) { if(Date.now()>deadline){const e=new Error('Agent capacity is full; retry later.');e.status=429;throw e;} await sleep(50); }
      }
      try {
        const instructions = await readFile(this.instructions,'utf8');
        const workspace = join(this.workRoot,id);
        const context = await this.provision(this, id, workspace, instructions);
        const historyPath=join(this.root,`history-${id}.json`);
        const history=await json(historyPath,[]);
        const result=await operation({ ...context, instructions, history, key });
        await save(historyPath,[...history,{role:'user',content:task},{role:'assistant',content:result.output}].slice(-24));
        return {...result, instructionsVersion:digest(instructions).slice(0,12)};
      } finally { await unlink(slot).catch(()=>{}); }
    });
  }
}

async function provisionLinuxUser(store, id, base, instructions) {
  assertTrustedDevelopment(store.config);
  if(store.config.MODEL_PROVIDER!=='codex') {await mkdir(base,{recursive:true,mode:0o700});return {workspace:base};}
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Session command isolation requires the root supervisor in the Linux guest.');
  const recordPath=join(store.root,`user-${id}.json`);
  let record=await json(recordPath,null);
  if(!record) await lock(join(store.root,'users.lock'),async()=>{
    record=await json(recordPath,null);
    if(record)return;
    const counterPath=join(store.root,'next-uid.json');
    let uid=await json(counterPath,30000);
    while(true){ try {await exec('/usr/bin/getent',['passwd',String(uid)]); uid++;}catch(e){if(e.code===2)break;throw e;} }
    await mkdir(base,{recursive:true,mode:0o700});
    await exec('/usr/sbin/useradd',['-U','-M','-d',join(base,'home'),'-s','/bin/sh','-u',String(uid),`chat${uid}`]);
    const group=await exec('/usr/bin/id',['-g',`chat${uid}`]);
    record={uid,gid:Number(group.stdout.trim())}; await save(recordPath,record); await save(counterPath,uid+1);
  });
  // Keep the parent root-owned so a child cannot replace a managed directory
  // with a symlink and trick a later privileged setup into following it.
  await mkdir(base,{recursive:true,mode:0o711});await chown(base,0,0);await chmod(base,0o711);
  const home=join(base,'home'), workspace=join(base,'workspace'), codexHome=join(base,'codex'), temp=join(base,'tmp');
  for(const path of [home,workspace,codexHome,temp]) { await mkdir(path,{recursive:true,mode:0o700});if(!(await lstat(path)).isDirectory())throw Error('Invalid session directory'); await chmod(path,0o700); await chown(path,record.uid,record.gid); }
  const master=store.config.CODEX_HOME || '/work/codex-home';
  await chmod(master,0o700);
  const auth=join(codexHome,'auth.json');
  // Only trusted developer sessions may receive this cache. Never provision
  // buyer sessions here: their own shell would be able to read this file.
  try {const file=await open(auth,'wx',0o600);try{await file.writeFile(await readFile(join(master,'auth.json')));await file.chown(record.uid,record.gid);}finally{await file.close();}}catch(e){if(e.code!=='EEXIST')throw e;}
  const publicSkills='/work/agent-public-skills';
  await lock(join(store.root,'skills.lock'),async()=>{try{await access(publicSkills);}catch{await cp(join(master,'skills'),publicSkills,{recursive:true});}});
  try{await symlink(publicSkills,join(codexHome,'skills'));}catch(e){if(e.code!=='EEXIST')throw e;}
  await installInstructions(store.root,workspace,instructions,record);
  return {workspace,home,codexHome,temp,uid:record.uid,gid:record.gid};
}

export async function installInstructions(root,workspace,text,owner) {
  const temp=join(root,`instructions-${randomUUID()}.tmp`);
  try{
    await writeFile(temp,text,{mode:0o600});
    if(owner)await chown(temp,owner.uid,owner.gid);
    // rename replaces a symlink itself, rather than overwriting its target.
    await rename(temp,join(workspace,'AGENTS.md'));
  }finally{await unlink(temp).catch(()=>{});}
}
