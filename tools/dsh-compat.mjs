#!/usr/bin/env node
/** Boujoy 1.x client -> pinned DSH 0.2 Remote API. All auth stays in this process. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export async function startBridge({upstreamRoot, home, port, cwd=process.cwd(), node=process.execPath}) {
 const require=createRequire(path.join(upstreamRoot,'package.json'));
 const {WebSocket,WebSocketServer}=require('ws');
 const version=JSON.parse(fs.readFileSync(path.join(upstreamRoot,'node_modules/@deepseek-ai/dsh/package.json'))).version;
 const {expandAssistantStream}=await import(pathToFileURL(path.join(upstreamRoot,'node_modules/@deepseek-ai/dsh-llm/lib/index.js')));
 const expandAttempt=attempt=>attempt?{...attempt,stream:expandAssistantStream(attempt.stream)}:null;
 const contracts=new Map();
 for(const name of fs.readdirSync(path.join(upstreamRoot,'node_modules/@deepseek-ai'))) {
  const filename=path.join(upstreamRoot,'node_modules/@deepseek-ai',name,'lib/typert.host.js');
  if(!fs.existsSync(filename))continue;
  const {TYPERT}=await import(pathToFileURL(filename));
  for(const item of TYPERT.invocations||[])contracts.set(`${item.namespace}/${item.method}`,item);
 }
 let child,origin,cookie,remote,clientId,closing=false,nextStream=0;
 const logical=new Map(),pending=new Map(),clients=new Set(),childParents=new Map();
 const wss=new WebSocketServer({noServer:true});
 const address=sessionId=>childParents.has(sessionId)?{kind:'subagent',parentSessionId:childParents.get(sessionId),childSessionId:sessionId,mode:'unknown'}:{kind:'session',sessionId};
 function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(body);}
 function emit(payload,rpcId=randomUUID(),kind='mux',target) {
  const message=JSON.stringify({type:'server-request',rpcId,payload});
  for(const c of target?[target]:clients)if(c.kind===kind && c.socket.readyState===WebSocket.OPEN)c.socket.send(message);
 }
 async function call(endpoint,args={}) {
  const id=randomUUID();
  const response=await fetch(origin+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({type:'client-request',rpcId:id,method:endpoint,payload:{args}}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Upstream ${endpoint}: HTTP ${response.status}`);
  const wire=await response.json();if(!wire.result?.ok)throw Object.assign(new Error(wire.result?.error?.message||'Upstream RPC failed'),{code:wire.result?.error?.code});return wire.result.value;
 }
 function openStream(endpoint,args,onItem) {
  const id=String(++nextStream);const opening=Promise.withResolvers();let opened=false;
  const timer=setTimeout(()=>{if(!opened){opening.reject(new Error(`Stream ${endpoint} opening timed out`));cancel();}},15000);
  const cancel=()=>{clearTimeout(timer);logical.delete(id);if(remote?.readyState===WebSocket.OPEN)remote.send(JSON.stringify({type:'cancel',streamId:id}));};
  logical.set(id,{item(value){if(!opened){opened=true;clearTimeout(timer);opening.resolve(value);}onItem?.(value);},error(error){clearTimeout(timer);if(!opened)opening.reject(new Error(error.message));else emit({type:'host/agent-error',message:error.message},undefined,'host');logical.delete(id);}});
  remote.send(JSON.stringify({type:'open',streamId:id,endpoint,payload:{args}}));
  return {id,first:opening.promise,cancel};
 }
 async function snapshot(endpoint,args) {const stream=openStream(endpoint,args);try{return await stream.first;}finally{stream.cancel();}}
 function projection(sessionId,key,value,seq,target) {
  emit({type:'session/projection',sessionId,key,value,seq},undefined,'mux',target);
  if(key==='inbox')emit({type:'session/queue',sessionId,items:[...(value?.['next-turn']||[]).map(x=>({...x,placement:'next-turn'})),...(value?.['next-step']||[]).map(x=>({...x,placement:'next-step'}))]},undefined,'mux',target);
 }
 function releaseFollow(client) {
  client.follow?.cancel();client.follow=null;client.sessionId=null;
 }
 function follow(client,sessionId) {
  if(client.sessionId===sessionId)return;releaseFollow(client);client.sessionId=sessionId;
  const send=payload=>emit(payload,undefined,'mux',client);
  // One ordered upstream cursor per browser. Rejoining while another device
  // follows the same session must still receive its own reconnect baseline.
  client.follow=openStream('session/follow',{request:{address:address(sessionId),assistantStream:true,maxMessages:200}},entry=>{
   if(entry.type==='snapshot') {
    send({type:'session/subscribed',sessionId,lastSeq:entry.cursor});
    for(const [key,value]of Object.entries(entry.projections?.values||{}))projection(sessionId,key,value,entry.projections.asOfSeq,client);
    send({type:'session/stream-snapshot',sessionId,attempt:expandAttempt(entry.assistantStream?.activeAttempt)});
   } else if(entry.type==='event')send({type:'session/event',sessionId,event:entry.event,view:entry.view});
   else if(entry.type==='assistant-stream') {
    const f=entry.frame;
    if(f.type==='start')send({type:'session/stream-snapshot',sessionId,attempt:{...f,stream:[]}});
    if(f.type==='end'&&(f.outcome.kind==='abandoned'||f.outcome.eventType==='assistant/attempt'))send({type:'session/stream-snapshot',sessionId,attempt:null});
    if(f.type==='chunk')send({type:'session/event',sessionId,event:{type:'assistant/chunk',time:f.time,data:{chunk:f.chunk,attemptId:f.attemptId}}});
   }
  });
  client.follow.first.catch(error=>{client.sessionId=null;emit({type:'host/agent-error',message:error.message},undefined,'host');});
 }
 function onRemoteEvent(frame) {
  if(frame.type==='ready'){clientId=frame.clientId;return;}
  if(frame.type==='cancel') {
   const item=pending.get(frame.eventId);if(item){item.claim?.cancel();emit({type:item.kind==='approval'?'approval/resolved':'question/resolved',approvalId:frame.eventId,questionRpcId:frame.eventId});pending.delete(frame.eventId);}return;
  }
  if(frame.type==='waterfall') {
   const kind=frame.event==='approval/request'?'approval':frame.event==='user-questions/request'?'question':null;
   if(!kind){call('$events/result',{clientId,eventId:frame.eventId,outcome:{kind:'next'}}).catch(()=>{});return;}
   const item={kind,sessionId:frame.agentId,...frame.request};pending.set(frame.eventId,item);
   if(kind==='question'&&frame.request.wait?.timed&&frame.request.wait.callId){item.claim=openStream('userQuestions/attachWait',{agentId:frame.agentId,callId:frame.request.wait.callId});item.claim.first.catch(()=>{});}
   emit({type:kind==='approval'?'approval/requested':'question/requested',sessionId:frame.agentId,approvalId:frame.eventId,...frame.request},frame.eventId);return;
  }
  if(frame.type!=='emit')return;
  const [a,b]=frame.args||[];
  if(frame.event==='api-session/status')emit({type:'host/session-status',sessionId:a,running:b},undefined,'host');
  if(frame.event==='api-session/added'||frame.event==='api-session/removed')emit({type:frame.event.replace('api-session/','host/session-'),sessionId:a?.sessionId||a},undefined,'host');
  if(frame.event==='api-session/error')emit({type:'host/agent-error',sessionId:a,message:b?.message||String(b)},undefined,'host');
 }
 const aliases={'settings.openDocument':'settings/openSettingsDocument','host.pickDirectory':'directoryPicker/pick','llm.providers':'llm/listProviders','skill.list':'skills/list','agentPreset.list':'agentPresets/list','agentPreset.read':'agentPresets/read','agentPreset.select':'agentPresets/select','subagent.prompt':'subagents/prompt','subagent.interrupt':'subagents/interruptByParent'};
 async function history(payload,subagent=false){
  const target=subagent?{kind:'subagent',parentSessionId:payload.parentSessionId,childSessionId:payload.childSessionId,mode:payload.mode||'unknown'}:address(payload.sessionId);
  const snap=await snapshot('session/follow',{request:{address:target,maxMessages:payload.maxMessages||200,assistantStream:true}});
  const page=payload.beforeSeq==null?snap:await call('session/page',{request:{address:target,throughSeq:snap.cursor,beforeSeq:payload.beforeSeq,maxMessages:payload.maxMessages||200,assistantStream:true}});
  return {events:page.records,hasMore:page.hasMore,projections:snap.projections,header:snap.header,assistantStream:snap.assistantStream?{...snap.assistantStream,activeAttempt:expandAttempt(snap.assistantStream.activeAttempt)}:undefined};
 }
 async function legacy(method,payload={},requestId=randomUUID()) {
  if(method==='host.describe') {const cat=await call('session/modelCatalog');return {...cat.default,boujoyProtocol:2,version,engineVersion:version,cwd,home};}
  if(method==='session.list'){const list=await call('session/list',{_request:payload});for(const row of list.items)if(row.origin==='subagent'&&row.parentSessionId)childParents.set(row.sessionId,row.parentSessionId);return list;}
  if(method==='workspace.list')return (await snapshot('workspace/follow',{})).value;
  if(method==='session.history')return history(payload);
  if(method==='subagent.history')return history(payload,true);
  if(method==='subagent.list') {const p=await call('session/projections',{request:{sessionId:payload.parentSessionId}});return {entries:(p?.values?.subagentCatalog||[]).map(item=>({...item,kind:['continuable','one-shot'].includes(item.mode)?'child':'diagnostic',reason:'子代理类型无法在本界面继续',activity:'可查看'}))};}
  if(method==='session.models'||method==='llm.models') {
   const cat=await call('session/modelCatalog');let current=cat.default;
   if(payload.sessionId){const p=await call('session/projections',{request:{sessionId:payload.sessionId}});current=p?.values?.modelSelection?.next||p?.values?.modelSelection?.lastUsed||current;}
   return {...cat,current};
  }
  if(method==='session.prompt'&&childParents.has(payload.sessionId))return call('subagents/prompt',{request:{parentSessionId:childParents.get(payload.sessionId),childSessionId:payload.sessionId,mode:'continuable',content:payload.content,clientTimeZone:payload.clientTimeZone,requestId}});
  if(method==='session.cancel'&&childParents.has(payload.sessionId))return call('subagents/interruptByParent',{parentSessionId:childParents.get(payload.sessionId),childSessionId:payload.sessionId,mode:'continuable'});
  if(method==='session.prompt'||method==='subagent.prompt')payload={...payload,requestId};
  if(method==='commands/execute')return call(method,{...payload.args,submittedAttachments:payload.args?.submittedAttachments||[]});
  if(method==='host.openPath')return call('session/openWorkspacePath',{request:{path:payload.path}});
  const endpoint=aliases[method]||(method.startsWith('goal.')?'goals/'+method.slice(5):method.replace('.','/'));
  const spec=contracts.get(endpoint);if(!spec)throw new Error(`新版不再提供 ${method}；预设声明请通过插件配置管理。`);
  let args={};
  for(const p of spec.parameters||[]) {
   if(p.wire==='request')args.request=payload;
   else if(p.wire==='_request')args._request=payload;
   else if(p.wire==='agentId')args.agentId=payload.sessionId;
   else if(Object.hasOwn(payload,p.wire))args[p.wire]=payload[p.wire];
  }
  if(endpoint.startsWith('goals/')&&args.request){const {sessionId,ref,...request}=payload;args.request=request;}
  if(endpoint==='llm/discoverModels')args={settingsNs:payload.settingsNs,request:{provider:payload.provider}};
  const result=await call(endpoint,args);
  if(method==='agentPreset.list')return result;
  return result;
 }
 function localHost(req) {
  const port = req.socket.localPort;
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
 }
 const server=http.createServer(async(req,res)=>{
  if(!localHost(req)){json(res,403,{error:'invalid loopback host'});return;}
  const requestOrigin=req.headers.origin;
  if(requestOrigin&&requestOrigin!==`http://127.0.0.1:${port}`&&requestOrigin!==`http://localhost:${port}`){json(res,403,{error:'cross-origin request blocked'});return;}
  if(req.method==='GET'&&req.url==='/'){json(res,200,{service:'boujoy-dsh-compat',version,ready:true});return;}
  if(req.method!=='POST'||!req.url.startsWith('/api/')){json(res,404,{error:'not found'});return;}
  let request;
  try {
   const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>300*1024*1024)throw new Error('request too large');chunks.push(part);}
   request=JSON.parse(Buffer.concat(chunks).toString());
   const method=decodeURIComponent(req.url.slice(5));
   if(method==='respond') {
    const item=pending.get(request.rpcId);if(!item)throw new Error('交互已经结束，请刷新状态');
    const value=request.result?.value;
    if(!request.result?.ok||value?.sessionId!==item.sessionId)throw new Error('交互响应不匹配');
    let answer;
    if(item.kind==='approval'){if(!['allowed-once','rejected'].includes(value.outcome))throw new Error('无效审批');answer=value.outcome;}
    else answer=value.answer;
    await call('$events/result',{clientId,eventId:request.rpcId,outcome:{kind:'result',value:answer}});
    item.claim?.cancel();pending.delete(request.rpcId);json(res,200,{accepted:true});return;
   }
   if(request.type!=='client-request'||request.method!==method)throw new Error('RPC endpoint mismatch');
   const value=await legacy(method,request.payload,request.rpcId);
   json(res,200,{type:'server-response',rpcId:request.rpcId,result:{ok:true,value}});
  }catch(error){json(res,200,{type:'server-response',rpcId:request?.rpcId,result:{ok:false,error:{message:error.message,code:error.code||'BOUJOY_ADAPTER_ERROR'}}});}
 });
 server.on('upgrade',(req,socket,head)=>{
  if(!localHost(req)){socket.destroy();return;}
  if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`){socket.destroy();return;}
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!['/api/events.mux','/api/events.host'].includes(pathname)){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{
   const client={socket:ws,kind:pathname.endsWith('host')?'host':'mux'};clients.add(client);
   if(client.kind==='mux')for(const [id,item]of pending)ws.send(JSON.stringify({type:'server-request',rpcId:id,payload:{...item,claim:undefined,type:item.kind==='approval'?'approval/requested':'question/requested',approvalId:id}}));
   ws.on('message',raw=>{try{const m=JSON.parse(raw);if(m.type==='subscribe'&&typeof m.sessionId==='string')follow(client,m.sessionId);}catch{ws.close(1008,'invalid subscription');}});
   ws.on('close',()=>{releaseFollow(client);clients.delete(client);});
  });
 });
 const launch=Promise.withResolvers();let output='';
 child=spawn(node,[path.join(upstreamRoot,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--patch',fileURLToPath(new URL('./boujoy-upstream.patch.yml',import.meta.url)),'--host','127.0.0.1','--port','0','--no-open'],{cwd,env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{
  output+=chunk.toString();if(output.length>50000)output=output.slice(-25000);
  const match=output.replace(/\x1b\[[0-9;]*m/g,'').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
  if(match)launch.resolve(match[0]);
 });
 child.stderr.on('data',chunk=>process.stderr.write(chunk.toString().replace(/([?&]token=)[^\s]+/g,'$1[redacted]')));
 child.once('exit',(code)=>{launch.reject(new Error(`DSH exited with ${code}`));if(!closing)close().then(()=>{process.exitCode=1;});});
 async function close(){if(closing)return;closing=true;for(const c of clients)c.socket.close();for(const item of logical.values())item.error({message:'Engine stopped'});remote?.close();server.close();wss.close();child.kill('SIGTERM');}
 try {
  const url=await Promise.race([launch.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('DSH startup timed out')),30000);timer.unref();})]);
  origin=new URL(url).origin;
  const response=await fetch(url,{redirect:'manual'});cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  if(response.status!==303&&response.status!==302)throw new Error('Official authentication exchange failed');
  if(!cookie)throw new Error('Official authentication returned no session cookie');
  remote=new WebSocket(origin.replace('http:','ws:')+'/api/remote.mux',{headers:{Cookie:cookie}});
  await new Promise((resolve,reject)=>{remote.once('open',resolve);remote.once('error',reject);});
  remote.on('message',raw=>{try{const m=JSON.parse(raw);const stream=logical.get(m.streamId);if(m.type==='item')stream?.item(m.value);else if(m.type==='error')stream?.error(m.error);else if(m.type==='end')stream?.error({message:'Stream ended'});}catch(error){process.stderr.write('Malformed upstream frame: '+error.message+'\n');}});
  remote.on('close',()=>{if(!closing){for(const c of clients)c.socket.close();close().then(()=>{process.exitCode=1;});}});
  await openStream('$events',{},onRemoteEvent).first;
  await openStream('session/control',{},frame=>{
   if(frame.type==='projection')projection(frame.sessionId,frame.key,frame.value,frame.seq);
   else if(frame.type==='baseline')for(const [sid,p]of Object.entries(frame.value.projections))for(const [key,value]of Object.entries(p.values||{}))projection(sid,key,value,p.asOfSeq);
  }).first;
  await openStream('workspace/follow',{},frame=>{
   const value=frame.value||frame.workspace;if(frame.type==='upsert'&&value?.workspaceId)emit({type:'host/workspace-changed',workspace:{...value,id:value.workspaceId}},undefined,'host');
  }).first;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,close,version,legacy,upstreamPid:child.pid};
 }catch(error){await close();throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const root=process.env.BOUJOY_DSH_ROOT;
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'boujoy-runtime.json'),'utf8'));
 const args=process.argv.slice(2),portIndex=args.indexOf('--port');
 const port=portIndex<0?3080:Number(args[portIndex+1]);
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid loopback port');
 if(args.includes('--version')||args.includes('-v')){console.log(cfg.version);process.exit(0);}
 if(args[0]!=='web')throw new Error('此入口用于 Boujoy 桌面；命令行请使用固定版本上游 dsh。');
 const app=await startBridge({upstreamRoot:cfg.upstreamRoot,home:process.env.DSH_HOME,port,node:cfg.node});
 console.log(`Boujoy Harness engine ${app.version} ready on 127.0.0.1:${port}`);
 for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>app.close());
 const parent=process.ppid;const watcher=setInterval(()=>{if(process.ppid!==parent)app.close();},1000);watcher.unref();
}
