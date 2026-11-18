// Real 0.2 engine, synthetic loopback Messages API, empty temporary workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {startBridge} from '../tools/dsh-compat.mjs';
const upstreamRoot=process.env.BOUJOY_UPSTREAM_ROOT;
const {WebSocket}=createRequire(path.join(upstreamRoot,'package.json'))('ws');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-upgrade-'));
const work=path.join(temp,'workspace');await fs.mkdir(work);
const requests=[],sockets=[],bridges=[],checks=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<150;i++){const x=await fn();if(x)return x;await sleep(100);}throw new Error('Timeout: '+label);}
const mock=http.createServer(async(req,res)=>{
 try{
 let raw='';for await(const p of req)raw+=p;
 if(req.url.endsWith('/files')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'file',id:'file-synthetic',mime_type:'image/png',size_bytes:100,created_at:new Date().toISOString(),filename:'fixture.png'}));return;}
 const body=JSON.parse(raw);
 requests.push({model:body.model,path:req.url,sessionLog:!!body.session_log,image:JSON.stringify(body.messages).includes('"type":"image"')});
 assert.equal(req.url,'/v1/messages');assert.equal(body.model,'deepseek-flash');assert.ok(!body.session_log);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const event=x=>res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`);
 const title=JSON.stringify(body.system).includes('concise title');
 const user=body.messages?.filter(x=>x.role==='user').at(-1);
 const txt=JSON.stringify(user||{});
 const hasResult=JSON.stringify(body.messages?.at(-1)).includes('tool_result');
 let tool;
 if(!title&&!hasResult&&txt.includes('TEST_QUESTION'))tool={name:'ask_user_question',input:{questions:[{id:'test',question:'Choose a synthetic test option',options:[{label:'Yes'},{label:'No'}]}]}};
 if(!title&&!hasResult&&txt.includes('TEST_APPROVAL'))tool={name:'write',input:{file_path:path.join(temp,'outside.txt'),content:'synthetic approval fixture',sandbox_permissions:'danger-full-access',justification:'Test explicitly approved temporary fixture'}};
 event({type:'message_start',message:{id:'synthetic',usage:{input_tokens:20,output_tokens:0}}});
 if(tool){event({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call-'+Date.now(),name:tool.name,input:{}}});event({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(tool.input)}});}
 else{event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'LOCAL_'}});if(!title)await sleep(txt.includes('TEST_CANCEL')?5000:500);if(res.destroyed)return;event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}});}
 event({type:'content_block_stop',index:0});event({type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:5}});event({type:'message_stop'});res.end();
 }catch(e){res.destroy(e);}
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
async function boot(name){
 const home=path.join(temp,name);await fs.mkdir(home,{recursive:true});
 await fs.writeFile(path.join(home,'settings.yaml'),JSON.stringify({'session-log-deepseek':{enabled:false},'agent-default-model':{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'},'llm-deepseek':{baseURL:`http://127.0.0.1:${mock.address().port}`,models:[{id:'deepseek-flash',name:'V4.1 Flash',inputModalities:['text','image']}]}}));
 const app=await startBridge({upstreamRoot,home,cwd:work,port:0});bridges.push(app);
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 async function rpc(method,payload={}){const id=crypto.randomUUID();const r=await fetch(origin+'/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:id,method,payload})});const body=await r.json();assert.ok(body.result?.ok,JSON.stringify(body.result));return body.result.value;}
 async function connect(){const ws=new WebSocket(origin.replace('http:','ws:')+'/api/events.mux');sockets.push(ws);const frames=[];ws.on('message',raw=>frames.push(JSON.parse(raw)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return{ws,frames};}
 return{app,home,rpc,connect,origin};
}
process.env.DEEPSEEK_API_KEY='synthetic-local-only';delete process.env.DEEPSEEK_BASE_URL;
try{
 const a=await boot('knowledge'),b=await boot('clean');
 assert.equal((await a.rpc('host.describe')).engineVersion,'0.2.1-alpha.2');
 const workspace=(await a.rpc('workspace.create',{path:work})).workspace;
 assert.equal((await a.rpc('workspace.list')).items.length,1);
 await a.rpc('workspace.rename',{workspaceId:workspace.workspaceId,title:'Synthetic workspace'});
 assert.equal((await a.rpc('workspace.list')).items[0].title,'Synthetic workspace');checks.push('workspace create/list/rename');
 const sid=(await a.rpc('session.create',{workspaceId:workspace.workspaceId})).sessionId;
 await a.rpc('session.selectModel',{sessionId:sid,provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'});
 assert.equal((await a.rpc('session.models',{sessionId:sid})).current.model,'deepseek-flash');
 await a.rpc('commands/execute',{args:{agentId:sid,line:'/permission read-only'}});assert.equal((await a.rpc('session.history',{sessionId:sid})).projections.values.permissions.currentValue,'read-only');await a.rpc('commands/execute',{args:{agentId:sid,line:'/permission workspace-write'}});checks.push('permission command and state readback');
 assert.equal((await b.rpc('session.list')).items.length,0);checks.push('model selection and home isolation');
 assert.ok((await a.rpc('agentPreset.list')).presets.length);assert.ok((await a.rpc('agentPreset.read',{agentPreset:'standard'})).content);
 await a.rpc('agentPreset.select',{sessionId:sid,agentPreset:'standard'});
 assert.ok(Array.isArray((await a.rpc('skill.list',{sessionId:sid})).skills));
 assert.deepEqual((await a.rpc('subagent.list',{parentSessionId:sid})).entries,[]);checks.push('presets/skills/subagent catalog');
 const stream=await a.connect();stream.ws.send(JSON.stringify({type:'subscribe',sessionId:sid}));
 await until(()=>stream.frames.find(f=>f.payload.type==='session/subscribed'),'subscription');
 await a.rpc('session.prompt',{sessionId:sid,mode:'queue',content:[{type:'text',text:'TEST_STREAM'}]});
 await until(()=>stream.frames.find(f=>f.payload.event?.type==='assistant/chunk'&&f.payload.event.data.chunk.type==='text-delta'),'live chunks');
 const second=await a.connect();second.ws.send(JSON.stringify({type:'subscribe',sessionId:sid}));
 await until(()=>second.frames.find(f=>f.payload.type==='session/stream-snapshot'),'second client baseline');
 assert.equal(stream.frames.filter(f=>f.payload.event?.type==='assistant/chunk'&&f.payload.event.data.chunk.text==='LOCAL_').length,1);second.ws.close();checks.push('independent multi-client stream baselines');
 const h=await until(async()=>{const x=await a.rpc('session.history',{sessionId:sid});return x.events.some(e=>e.event.type==='assistant/message')&&x;},'persisted response');
 assert.ok(h.events.some(e=>e.event.type==='assistant/message'&&(e.event.data.message||e.event.data).content?.[0]?.text==='LOCAL_OK'));checks.push('Messages API prompt/stream/history');
 await a.rpc('session.rename',{sessionId:sid,title:'Upgrade test'});
 assert.ok((await a.rpc('session.search',{query:'TEST_STREAM'})).items.length);
 const fork=(await a.rpc('session.fork',{sessionId:sid})).sessionId;assert.notEqual(fork,sid);
 assert.ok((await a.rpc('session.history',{sessionId:fork})).events.length);
 const page=await a.rpc('session.history',{sessionId:sid,beforeSeq:h.events.at(-1).event.seq,maxMessages:1});assert.ok(Array.isArray(page.events));
 await a.rpc('workspace.archiveSession',{sessionId:fork});assert.ok((await a.rpc('workspace.list')).archivedSessionIds.includes(fork));checks.push('rename/search/fork/paging/archive');
 // Close/reopen subscription during an active attempt, then cancel it.
 await until(async()=>!(await a.rpc('session.list')).items.find(x=>x.sessionId===sid).running,'idle');
 await a.rpc('session.prompt',{sessionId:sid,mode:'queue',content:[{type:'text',text:'TEST_CANCEL'}]});
 await until(async()=>(await a.rpc('session.history',{sessionId:sid})).assistantStream?.activeAttempt,'active attempt');stream.ws.close();
 const re=await a.connect();re.ws.send(JSON.stringify({type:'subscribe',sessionId:sid}));
 assert.ok((await until(()=>re.frames.find(f=>f.payload.type==='session/stream-snapshot'&&f.payload.attempt),'reconnect')).payload.attempt.stream.some(x=>x.chunk?.type==='text-delta'&&x.chunk.text==='LOCAL_'));
 await a.rpc('session.cancel',{sessionId:sid});await until(async()=>!(await a.rpc('session.list')).items.find(x=>x.sessionId===sid).running,'cancel');checks.push('reconnect snapshot/cancel');
 for(const type of ['question','approval','approval-allow']){
  const kind=type.startsWith('approval')?'approval':type;
  const child=(await a.rpc('session.create')).sessionId;re.ws.send(JSON.stringify({type:'subscribe',sessionId:child}));
  await a.rpc('session.prompt',{sessionId:child,mode:'queue',content:[{type:'text',text:type==='question'?'TEST_QUESTION':'TEST_APPROVAL'}]});
  const f=await until(()=>re.frames.find(x=>x.payload.type===kind+'/requested'&&x.payload.sessionId===child),type+' request');
  const body={type:'client-response',rpcId:f.rpcId,result:{ok:true,value:{sessionId:child,...(kind==='approval'?{approvalId:f.rpcId,outcome:type==='approval-allow'?'allowed-once':'rejected'}:{answer:{answers:[{id:'test',selected:['Yes']}]}})}}};
  const resp=await(await fetch(a.origin+'/api/respond',{method:'POST',body:JSON.stringify(body)})).json();assert.equal(resp.accepted,true,JSON.stringify(resp));
  await until(async()=>!(await a.rpc('session.list')).items.find(x=>x.sessionId===child).running,type+' completed');
  const replay=await(await fetch(a.origin+'/api/respond',{method:'POST',body:JSON.stringify(body)})).json();assert.equal(replay.result.ok,false);
  if(type==='approval-allow')assert.equal(await fs.readFile(path.join(temp,'outside.txt'),'utf8'),'synthetic approval fixture');
  checks.push(type+' waterfall/result/replay rejection');
 }
 const imageSid=(await a.rpc('session.create')).sessionId;
 await a.rpc('session.prompt',{sessionId:imageSid,mode:'queue',content:[{type:'text',text:'TEST_IMAGE'},{type:'image',mediaType:'image/png',data:(await fs.readFile(new URL('../web/icon-192.png',import.meta.url))).toString('base64')}]});
 await until(async()=>!(await a.rpc('session.list')).items.find(x=>x.sessionId===imageSid).running,'image');assert.ok(requests.some(x=>x.image));checks.push('image intake and Messages image payload');
 const settings=await a.rpc('settings.describe');assert.ok(settings.namespaces.length);await a.rpc('settings.update',{ns:'agent-default-model',patch:{reasoningEffort:'off'}});checks.push('settings describe/update');
 const gs=(await a.rpc('session.create')).sessionId;const goal=await a.rpc('goal.create',{sessionId:gs,objective:'Synthetic goal',maxGoalRounds:1});
 await a.rpc('goal.pause',{sessionId:gs,ref:goal.ref});const paused=await a.rpc('goal.get',{sessionId:gs});assert.ok(paused);checks.push('goal create/pause/get');
 assert.ok(!requests.some(r=>r.sessionLog));checks.push('no session-log upload');
 console.log(JSON.stringify({engine:'0.2.1-alpha.2',checks,loopbackRequests:requests.length,cloudRequests:0}));
}catch(e){console.error('Completed:',checks);throw e;}
finally{for(const s of sockets)s.terminate();for(const a of bridges)await a.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await fs.rm(temp,{recursive:true,force:true});}
