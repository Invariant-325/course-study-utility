const {app,BrowserWindow,WebContentsView,session,nativeImage}=require('electron');
const assert=require('node:assert/strict');
const {createQuestionCapture}=require('../desktop/question-capture.cjs');
app.whenReady().then(async()=>{
 let win;
 try{
  const ses=session.fromPartition('native-capture-fixture');
  const colors=['#00ff00','#ff0000','#0000ff'];
  const html='<style>html{scroll-behavior:smooth}@font-face{font-family:missing-decoration;src:url(/missing.woff2)}.decoration{font-family:missing-decoration,monospace}.TiMu{padding:24px;margin-bottom:1400px;font:24px monospace;background:#fff}</style>'+colors.map((color,i)=>'<div class="TiMu"><p>Question '+(i+1)+'</p><p>A. First B. Second</p><span class="decoration">optional decoration</span><br><svg width="120" height="80"><rect width="120" height="80" fill="'+color+'"/></svg></div>').join('');
  await ses.protocol.handle('https',req=>req.url.endsWith('.woff2')?new Response('',{status:404}):new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}}));
  win=new BrowserWindow({show:false});const view=new WebContentsView({webPreferences:{session:ses,backgroundThrottling:false}});win.contentView.addChildView(view);view.setBounds({x:0,y:0,width:900,height:700});
  await view.webContents.loadURL('https://unit.chaoxing.com/work/doHomeWorkNew');
  await view.webContents.executeJavaScript('window.__cxChapterQuiz={parse:()=>({questions:[...document.querySelectorAll(".TiMu")].map((el,i)=>({key:"fixture-"+i,el}))})};true');
  const capture=createQuestionCapture({browser:{view}}),before=view.getBounds();
  for(let round=0;round<2;round++)for(let q=0;q<3;q++){
   const result=await capture.capture({questionId:'fixture-'+q,...(round?{minWidth:1600}:{})});assert(result.ok,result.reason);assert.equal(result.source,'browser-screenshot');
   const bitmap=nativeImage.createFromDataURL(result.dataUrl).toBitmap();let matching=0;const channel=[1,2,0][q];
   for(let n=0;n<bitmap.length;n+=4)if(bitmap[n+channel]>200&&[0,1,2].filter(c=>c!==channel).every(c=>bitmap[n+c]<40))matching++;
   assert(matching>100,'capture must contain the selected question diagram, not a stale or blank crop');assert.deepEqual(view.getBounds(),before);assert.equal(await view.webContents.executeJavaScript('scrollY'),0);
  }
  assert.equal((await capture.capture({questionId:'missing-question'})).ok,false);
  console.log('PASS six hidden captures: smooth-scroll positions, missing decorative font, per-question colored SVG, wider retry, unchanged original viewport and scroll; unknown key rejected');
 }catch(e){console.error(e.stack);process.exitCode=1}finally{win?.destroy();app.exit(process.exitCode||0)}
});
