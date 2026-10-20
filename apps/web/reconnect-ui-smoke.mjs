import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const base=process.env.BASE_URL,dir=process.env.OUTPUT_DIR??'/private/tmp/poker-stage4-root-20261016';
assert(base&&['localhost','127.0.0.1'].includes(new URL(base).hostname));
await mkdir(dir,{recursive:true});
const browser=await chromium.launch({headless:true}),checks=[],errors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<600;i++){if(await fn())return;await pause(25);}throw Error(label);}
async function player(name,code){
 const context=await browser.newContext(),page=await context.newPage(),p={context,page,view:null,blocked:false,commands:0,sockets:0,transport:null};
 await page.routeWebSocket('**/socket.io/**',ws=>{if(p.blocked){ws.close();return;}p.transport=ws;ws.connectToServer();});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('websocket',ws=>{p.sockets++;ws.on('framesent',frame=>{if(String(frame.payload).includes('"command"'))p.commands++;});ws.on('framereceived',frame=>{const raw=String(frame.payload);if(raw.startsWith('42'))try{const [event,value]=JSON.parse(raw.slice(2));if(event==='state.snapshot')p.view=value;}catch{}});});
 await page.goto(base);await page.locator('#nickname-input').fill(name);
 if(code){await page.locator('#room-code-input').fill(code);await page.locator('#join-room-btn').click();}else await page.locator('#create-room-btn').click();
 await until(()=>p.view,'initial real snapshot');return p;
}
const mark=name=>checks.push({case:name,result:'PASS'});
try{
 const host=await player('恢复房主'),guest=await player('恢复玩家',host.view.roomCode),ps=[host,guest];
 for(const p of ps){await p.page.locator('.seat-node.is-empty').first().click();await until(()=>p.view.yourSeatIndex!==null,'seat');await p.page.getByRole('button',{name:'准备',exact:true}).click();await p.page.getByRole('button',{name:'取消准备',exact:true}).waitFor();}
 await host.page.getByRole('button',{name:'开始第一手',exact:true}).click();await until(()=>host.view.stage==='preflop','real game');
 const p=guest,identity={room:p.view.roomId,member:p.view.participantId,seat:p.view.yourSeatIndex,cards:JSON.stringify(p.view.yourHoleCards)};
 p.blocked=true;p.transport.close();await p.context.setOffline(true);await p.page.getByRole('button',{name:'重新连接',exact:true}).waitFor();
 await until(()=>p.page.locator('fieldset').evaluate(el=>el.disabled),'offline controls disabled');const commands=p.commands;
 await p.page.keyboard.press('Enter');assert.equal(p.commands,commands);mark('offline controls and keyboard do not send commands');
 for(const [width,height] of [[1440,900],[375,812],[568,320]]){
  await p.page.setViewportSize({width,height});const b=p.page.getByRole('button',{name:'重新连接',exact:true});await b.scrollIntoViewIfNeeded();const box=await b.boundingBox();assert(box&&box.width>=44&&box.height>=44);assert(await p.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.page.screenshot({path:`${dir}/offline-${width}.png`,fullPage:true});
 }
 mark('desktop and mobile portrait/landscape recovery target visible without horizontal overflow');
 await p.context.setOffline(false);
 await p.page.route('**/api/v1/session/active-room',async route=>{await pause(700);p.blocked=false;await route.continue();});
 await p.page.getByRole('button',{name:'重新连接',exact:true}).click();assert(await p.page.getByRole('button',{name:'正在恢复…',exact:true}).isDisabled());assert(await p.page.locator('fieldset').evaluate(el=>el.disabled));
 await until(async()=>!await p.page.locator('fieldset').evaluate(el=>el.disabled),'recovered authoritative snapshot');
 assert.equal(p.view.roomId,identity.room);assert.equal(p.view.participantId,identity.member);assert.equal(p.view.yourSeatIndex,identity.seat);assert.equal(JSON.stringify(p.view.yourHoleCards),identity.cards);assert.equal(p.commands,commands);mark('manual authenticated recovery restores same room member seat and private cards without command replay');
 await p.page.unroute('**/api/v1/session/active-room');await p.page.reload();await until(()=>p.page.locator('fieldset').evaluate(el=>!el.disabled),'refresh recovery');mark('refresh reconnects existing membership');
 const cold=await browser.newContext(),page=await cold.newPage();await page.route('**/api/v1/session/active-room',r=>r.fulfill({status:503,body:'{}'}));await page.goto(base);await page.getByRole('alert').waitFor();await page.unroute('**/api/v1/session/active-room');await page.getByRole('button',{name:'恢复房间',exact:true}).click();await page.getByText('当前没有可恢复的房间，请重新创建或加入。',{exact:true}).waitFor();mark('cold restore failure exposes retry and confirms no active room');
 assert.deepEqual(errors,[]);
}catch(error){checks.push({failure:error.stack});process.exitCode=1;}
finally{await writeFile(dir+'/results.json',JSON.stringify({checks,pageErrors:errors,scope:'local real two-browser game; simulated viewports, not physical devices or full Stage5'},null,2));console.log(JSON.stringify({checks,pageErrors:errors},null,2));await browser.close();}
