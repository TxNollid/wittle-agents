import {readFile,lstat,access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
async function privateFile(path){
 const st=await lstat(path);
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.nlink!==1||st.size>16384)throw Error('PRIVATE_CONTROLLER_FILE_REQUIRED');
 return (await readFile(path,'utf8')).trim();
}
export async function controllerConfig(){
 if(process.env.WITTLE_ENV_FILE)process.loadEnvFile(process.env.WITTLE_ENV_FILE);
 else if(process.env.NODE_ENV!=='production'){
  try{await access(new URL('../../.env',import.meta.url));process.loadEnvFile(new URL('../../.env',import.meta.url));}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 const directory=process.env.WITTLE_STATE_DIRECTORY||join(homedir(),'.local/state/wittle-agents');
 if(!isAbsolute(directory))throw Error('ABSOLUTE_STATE_DIRECTORY_REQUIRED');
 try{await access(join(directory,'controller-retired.json'));throw Error('CONTROLLER_RETIRED');}catch(error){if(error.code!=='ENOENT')throw error;}
 const solariApiKey=process.env.WITTLE_SOLARI_KEY_FILE?await privateFile(process.env.WITTLE_SOLARI_KEY_FILE):process.env.SOLARI_API_KEY;
 if(!solariApiKey)throw Error('SOLARI_BACKEND_CREDENTIAL_REQUIRED');
 if(process.env.WITTLE_REQUIRE_MIGRATED_STATE==='1')for(const name of ['openrouter-testing.sqlite','concierge-free.sqlite','migration-manifest.json','cutover-authorized.json'])await access(join(directory,name));
 return {directory,solariApiKey,statePath:process.env.WITTLE_CONCIERGE_BINDING_PATH||new URL('../../.solari/concierge.json',import.meta.url),keyPath:process.env.WITTLE_PROVIDER_KEY_PATH};
}
