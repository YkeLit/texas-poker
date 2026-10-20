import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import Redis from 'ioredis';
import {io} from 'socket.io-client';
import {RedisRoomStore} from '@ykelit/games-room-runtime';
import {buildApp} from '../src/app.ts';
const url=process.env.TEST_REDIS_URL,dir=process.env.TEST_OUTPUT_DIR??'/private/tmp/poker-exit-api-20261015/final';
assert(url&&new URL(url).hostname==='127.0.0.1','Dedicated loopback Redis required');await mkdir(dir,{recursive:true});
const redis=new Redis(url),prefix='room:v1:texas-poker:',store=new RedisRoomStore(redis,{keyPrefix:prefix});
assert.equal(await redis.dbsize(),0,'Dedicated empty database required');
const {app}=await buildApp({config:{host:'127.0.0.1',port:0,redisUrl:url,clientOrigin:'http://127.0.0.1:5173'}});
const base=await app.listen({host:'127.0.0.1',port:0}),sockets=[],checks=[];let accepted=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('timeout '+label);}
async function http(path,cookie,body,origin='http://127.0.0.1:5173'){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(origin===null?{}:{Origin:origin}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null,cookie:response.headers.get('set-cookie')?.split(';')[0],cookieFlags:response.headers.get('set-cookie')};
}
async function attach(p){p.socket=io(base,{transports:['websocket'],extraHeaders:{Cookie:p.cookie,Origin:'http://127.0.0.1:5173'},reconnection:false});sockets.push(p.socket);p.events=[];p.view=null;p.socket.on('state.snapshot',v=>p.view=v);p.socket.on('room.expired',e=>p.events.push(e));await new Promise((resolve,reject)=>{p.socket.once('connect',resolve);p.socket.once('connect_error',reject)});const ack=await p.socket.timeout(3000).emitWithAck('room.attach',{roomId:p.roomId});assert(ack.ok);await until(()=>p.view,'attach snapshot');return p;}
async function sync(ps){const current=await store.getRoom(ps[0].roomId);for(const p of ps)if(current.participants.some(x=>x.guestId===p.guestId)&&p.socket.connected)await until(()=>p.view?.revision>=current.revision,'public snapshot');return current;}
async function command(p,type,payload={}){let room=await store.getRoom(p.roomId);const result=await p.socket.timeout(3000).emitWithAck('command',{protocolVersion:1,requestId:randomUUID(),roomId:p.roomId,expectedRevision:room.revision,type,payload});assert(result.ok,type+': '+JSON.stringify(result.error));accepted++;await until(()=>p.view?.revision>=result.revision,'command snapshot');return result;}
async function group(n=3,start=true,seconds=2){
 const config={maxPlayers:9,startingStack:1000,smallBlind:10,bigBlind:20,actionTimeSeconds:seconds,rebuyCooldownHands:2};
 const created=await http('/api/v1/rooms',null,{nickname:'验收房主',config});assert.equal(created.status,201);assert(/HttpOnly/i.test(created.cookieFlags)&&/Secure/i.test(created.cookieFlags)&&/SameSite=Lax/i.test(created.cookieFlags));
 const ps=[{cookie:created.cookie,roomId:created.body.roomId}];for(let i=1;i<n;i++){const joined=await http('/api/v1/rooms/join',null,{nickname:'验收盟友'+i,roomCode:created.body.roomCode});assert.equal(joined.status,200);ps.push({cookie:joined.cookie,roomId:created.body.roomId});}
 for(const p of ps){await attach(p);const room=await store.getRoom(p.roomId);p.guestId=room.participants.find(x=>x.id===p.view.participantId).guestId;}
 for(let i=0;i<n;i++){await command(ps[i],'seat.take',{seatIndex:i});await command(ps[i],'player.ready');}if(start)await command(ps[0],'hand.start');await sync(ps);return ps;
}
async function leave(p,origin){return http('/api/v1/rooms/'+p.roomId+'/leave',p.cookie,{},origin);}
try{
 const ps=await group(),room=await store.getRoom(ps[0].roomId),index=room.state.engine.actingSeatIndex,leaver=ps[index],deadline=room.state.engine.actionDeadlineAt;
 const twin={cookie:leaver.cookie,roomId:leaver.roomId};await attach(twin);assert.equal((await leave(leaver)).status,204);
 const left=await store.getRoom(leaver.roomId),revision=left.revision;await sleep(Math.max(0,Date.parse(deadline)-Date.now())+600);
 const after=await store.getRoom(leaver.roomId),advanced=after.revision>revision;
 if(process.env.TEST_BASELINE==='1'){
  checks.push({case:'actual current-player permanent exit at deadline',memberRemoved:!after.participants.some(x=>x.id===leaver.view.participantId),actorSeatRetained:after.state.engine.actingSeatIndex===index,revisionAdvanced:advanced,leftEvents:leaver.events.length+twin.events.length,stage:after.state.engine.stage});
  assert(!advanced&&after.state.engine.actingSeatIndex===index,'baseline changed');
 }else{
  assert(advanced,'timer must advance after actor permanently leaves');assert.equal((await http('/api/v1/session/active-room',leaver.cookie)).body.activeRoom,null);
  assert(leaver.events.some(x=>x.reason==='left')&&twin.events.some(x=>x.reason==='left'));checks.push({case:'current departed actor timed auto-fold and double-socket revocation'});
  const kept=ps.filter(p=>p!==leaver);let steps=0;
  while(steps++<60){const current=await store.getRoom(kept[0].roomId);if(current.state.engine.stage==='showdown')break;const actor=kept.find(p=>p.view?.yourSeatIndex===current.state.engine.actingSeatIndex);assert(actor,'remaining real member actor');await sync(kept);const action=actor.view.yourAvailableActions.find(x=>x.type==='check')??actor.view.yourAvailableActions.find(x=>x.type==='call')??actor.view.yourAvailableActions.find(x=>x.type==='fold');assert(action);await command(actor,'action.submit',{type:action.type});await sync(kept);}
  const ended=await store.getRoom(kept[0].roomId);assert.equal(ended.state.engine.stage,'showdown');assert.equal(ended.state.engine.seats[index],null);assert(ended.state.engine.lastResult);checks.push({case:'natural remaining players finish full hand; departed seat cleaned after settlement',actions:steps-1});
  const result=structuredClone(ended.state.engine.lastResult);assert.equal((await leave(kept[0])).status,204);assert.deepEqual((await store.getRoom(kept[1].roomId)).state.engine.lastResult,result);checks.push({case:'settled result survives exit'});
  const lobby=await group(2,false);assert.equal((await leave(lobby[0])).status,204);const l=await store.getRoom(lobby[0].roomId);assert.equal(l.participants.length,1);assert.equal(l.state.engine.seats[0],null);assert.equal(l.hostParticipantId,l.participants[0].id);checks.push({case:'lobby host transfer and seat cleanup'});
  const denied=await group(2,false);const before=await store.getRoom(denied[0].roomId);assert.equal((await leave(denied[0],'https://evil.invalid')).status,403);assert.equal((await store.getRoom(denied[0].roomId)).revision,before.revision);checks.push({case:'explicit malicious Origin cannot leave'});
 }
}catch(error){checks.push({failure:error.stack});process.exitCode=1;}
finally{
 await writeFile(dir+'/results.json',JSON.stringify({checks,acceptedCommands:accepted,base,scope:'real HTTP/SIO/Redis; no browser or hardware claim'},null,2));console.log(JSON.stringify({checks,acceptedCommands:accepted}));for(const socket of sockets)socket.disconnect();await app.close();const keys=await redis.keys(prefix+'*');if(keys.length)await redis.del(...keys);await redis.quit();
}
