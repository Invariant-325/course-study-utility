const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path'),assert=require('node:assert/strict');
let mode='idle',calls=[];ipcMain.on('probe',()=>{});ipcMain.handle('control-state',()=>({ok:true,mode,reason:mode==='waiting'?'本章习题未提交':'',runner:mode==='idle'?null:{state:mode==='playing'?'playing':mode==='paused'?'paused':'locating',running:mode==='playing'},video:mode==='playing'?{paused:false,ended:false,duration:100,currentTime:50}:mode==='paused'?{paused:true,ended:false,duration:100,currentTime:50}:null}));
ipcMain.handle('control-command',(_e,action)=>{calls.push(action);mode=action==='pause'||action==='stop'?'paused':'playing';return{ok:true}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1440,height:900,webPreferences:{preload:path.join(__dirname,'controls-mock.cjs'),sandbox:true}});try{
 await win.loadFile(path.join(__dirname,'../desktop/ui/index.html'));const wc=win.webContents,js=code=>wc.executeJavaScript(code,true);
 const click=async id=>{const r=await js(`(()=>{const e=document.querySelector(${JSON.stringify(id)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...r});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...r});await pause(150)};
 const labels=()=>js(`[...['sideStart','nowToggle','wkPause']].map(id=>document.getElementById(id).textContent.trim())`);
 await pause(900);assert((await labels()).every(v=>v==='开始学习'));await click('#sideStart');assert.equal(calls.at(-1),'start');assert((await labels()).every(v=>v==='暂停'));
 await click('#nowToggle');assert.equal(calls.at(-1),'pause');assert((await labels()).every(v=>v==='继续学习'));await click('#nowToggle');assert.equal(calls.at(-1),'resume');
 assert.equal(await js('document.getElementById("sideStart").getBoundingClientRect().height'),0);assert.equal(await js('document.getElementById("wkPause").getBoundingClientRect().height'),0);assert.equal(await js('document.getElementById("fab").getBoundingClientRect().height'),0);console.log('PASS current-task button controls playback; duplicate sidebar/header/floating controls hidden on learning page');
 mode='paused';await pause(900);assert((await labels()).every(v=>v==='继续学习'));assert.equal(await js('document.getElementById("fabLabel").textContent'),'继续学习');
 mode='playing';await pause(900);assert((await labels()).every(v=>v==='暂停'));assert.equal(await js('document.getElementById("fabLabel").textContent'),'暂停');
 mode='preparing';await pause(1100);console.log('PREPARING',await labels());assert((await labels()).every(v=>v==='取消准备'));await click('#nowToggle');assert.equal(calls.at(-1),'pause');
 console.log('PASS website pause/play, chapter playback and prepare/cancel update all controls within polling interval');
 mode='review';await pause(900);assert.equal(await js('document.getElementById("nowToggle").textContent.trim()'),'重新检查本章');assert.equal(await js('[...document.querySelectorAll("button")].filter(e=>e.getClientRects().length&&e.textContent.trim()==="重试").length'),0);
 mode='waiting';await pause(900);assert.equal(await js('document.getElementById("nowToggle").textContent.trim()'),'继续处理习题');assert.equal(await js('document.getElementById("nowState").textContent'),'等待习题处理');console.log('PASS review and waiting show explicit actions/reasons, no visible generic retry buttons');

 win.destroy();app.quit();
 }catch(e){console.error(e.stack);app.exit(1)}});
