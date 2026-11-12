const {app,BrowserWindow,WebContentsView,session}=require('electron');
const assert=require('node:assert/strict');const {createPlaybackController}=require('../desktop/playback-controller.cjs');
app.whenReady().then(async()=>{const ses=session.fromPartition('playback-fixture');await ses.protocol.handle('https',()=>new Response(`<video style="width:320px;height:200px"></video><script>window.mediaPaused=true;window.state='idle';window.running=false;window.calls={start:0,pause:0,resume:0,stop:0};const v=document.querySelector('video');Object.defineProperty(v,'paused',{get:()=>mediaPaused});Object.defineProperty(v,'ended',{get:()=>false});v.pause=()=>{mediaPaused=true};window.__cxNaturalWatchApp={runner:{snapshot:()=>({state,running}),start:()=>{calls.start++;state='playing';running=true;mediaPaused=false;return true},pause:()=>{calls.pause++;state='paused';running=false;mediaPaused=true;return true},resume:()=>{calls.resume++;state='playing';running=true;mediaPaused=false;return true},stop:()=>{calls.stop++;state='stopped';running=false;mediaPaused=true}}};</script>`,{headers:{'Content-Type':'text/html'}}));
const win=new BrowserWindow({show:false});const view=new WebContentsView({webPreferences:{session:ses}});win.contentView.addChildView(view);view.setBounds({x:0,y:0,width:900,height:700});let pending=false;
const controller=createPlaybackController({browser:{view},portal:{status:()=>({pendingStart:pending}),cancelStart:()=>{pending=false},start:async()=>{pending=true;return{ok:true,pending:true}}}});const js=c=>view.webContents.executeJavaScript(c,true);
try{
await view.webContents.loadURL('https://unit.chaoxing.com/mycourse/studentstudy');assert.equal((await controller.status()).mode,'idle');
assert((await controller.command('start')).ok);assert.equal((await controller.status()).mode,'playing');assert((await controller.command('start')).ok);assert.equal(await js('calls.start'),1);
assert((await controller.command('pause')).ok);assert.equal((await controller.status()).mode,'paused');assert(await js('mediaPaused'));assert((await controller.command('resume')).ok);assert.equal((await controller.status()).mode,'playing');
console.log('PASS start/pause/resume invoke actual runner and media; repeated start does not restart');
await js('mediaPaused=true;true');assert.equal((await controller.status()).mode,'paused');await controller.command('resume');assert.equal((await controller.status()).mode,'playing');
await js("state='paused';running=false;mediaPaused=false;true");assert.equal((await controller.status()).mode,'playing');await controller.command('pause');assert(await js('mediaPaused'));
console.log('PASS manual website pause/play overrides stale runner display, controls still act on media');
await controller.command('stop');assert.equal((await controller.status()).mode,'idle');assert(await js('mediaPaused'));
await js('window.__cxNaturalWatchApp=null;document.querySelector("video").remove();true');await controller.command('start');assert.equal((await controller.status()).mode,'preparing');await controller.command('pause');assert.equal(pending,false);assert.equal((await controller.status()).mode,'idle');
console.log('PASS stop and cancel-pending prevent delayed restart');
view.webContents.close();win.destroy();app.quit();}catch(e){console.error(e.stack);app.exit(1)}});
