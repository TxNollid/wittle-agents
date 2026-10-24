import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const PRIVATE_ROUTER_KEY=join(homedir(),'.config/wittle-agents/openrouter-api-key');
export async function readPrivateProviderKey(path=PRIVATE_ROUTER_KEY) {
  const directory=await lstat(dirname(path));
  if(!directory.isDirectory() || directory.uid!==process.getuid() || (directory.mode&0o077)!==0)throw Error('PRIVATE_KEY_PERMISSIONS');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile() || stat.uid!==process.getuid() || (stat.mode&0o077)!==0 || stat.nlink!==1 || stat.size>1024)throw Error('PRIVATE_KEY_PERMISSIONS');
    const key=(await file.readFile('utf8')).trim();
    if(!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(key))throw Error('PRIVATE_KEY_FORMAT');
    return key;
  }finally{await file.close();}
}
