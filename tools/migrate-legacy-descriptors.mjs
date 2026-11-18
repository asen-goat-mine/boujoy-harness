// 0.1.1 descriptors use v2; v3 adds optional reasoning effort, retaining the
// same spawn/fork identity and other fields. The official v0 reader rejects
// v2 before its normal migration. Normalize only validated v2 descriptors in
// a COPIED home; retain the exact original bytes in the upgrade backup.
import fs from 'node:fs/promises';import path from 'node:path';import zlib from 'node:zlib';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
export async function prepareLegacyDescriptors({home,upstreamRoot,backupDir}){
 const {assertReleasedEventPayload}=await import(pathToFileURL(path.join(upstreamRoot,'node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js')));
 const root=path.join(home,'sessions'),changes=[];
 let entries;try{entries=await fs.readdir(root,{recursive:true});}catch(error){if(error.code==='ENOENT')return changes;throw error;}
 for(const rel of entries){
  if(!rel.endsWith('session.jsonl.zstd'))continue;
  const file=path.join(root,rel),input=await fs.readFile(file);let offset=0,text='';
  while(offset<input.length){const result=zlib.zstdDecompressSync(input.subarray(offset),{info:true});if(!result.engine.bytesWritten)throw Error('Invalid Zstd frame');offset+=result.engine.bytesWritten;text+=result.buffer.toString();}
  const rows=text.trimEnd().split('\n').map(x=>JSON.parse(x));if(rows[0]?.version!==0)continue;
  let changed=0;
  for(const row of rows){if(row.type==='subagent/descriptor'&&row.data?.version===2){const migrated={...row,data:{...row.data,version:3}};assertReleasedEventPayload(migrated,0);row.data=migrated.data;changed++;}}
  if(!changed)continue;
  const backup=path.join(backupDir,rel);await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,input,{flag:'wx',mode:0o600});
  const rewritten=Buffer.concat([zlib.zstdCompressSync(Buffer.from(JSON.stringify(rows[0])+'\n')),zlib.zstdCompressSync(Buffer.from(rows.slice(1).map(x=>JSON.stringify(x)).join('\n')+'\n'))]);
  const staged=file+'.boujoy-migration';await fs.writeFile(staged,rewritten,{mode:0o600});await fs.rename(staged,file);
  changes.push({sessionId:rows[0].id,changedDescriptors:changed,originalSha256:createHash('sha256').update(input).digest('hex')});
 }
 return changes;
}
