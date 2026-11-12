const {BrowserWindow,session}=require('electron');
const {isAllowedNavigationUrl}=require('./browser-policy.cjs');
function createQuestionCapture({browser}){
 let busy=false;
 async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('capture-timeout')),ms)})]);}finally{clearTimeout(timer)}}
 const run=(frame,code)=>bounded(frame.executeJavaScript(code,true),4000);
 function frames(){const out=[],todo=browser.view?.webContents?.mainFrame?[browser.view.webContents.mainFrame]:[];while(todo.length&&out.length<100){const f=todo.shift();try{if(isAllowedNavigationUrl(f.url))out.push(f);todo.push(...f.frames)}catch{}}return out;}
 async function capture(request={}){
  if(busy)return {ok:false,reason:'正在截取上一道题'};const key=String(request.questionId||'');if(!key||key.length>512)return {ok:false,reason:'题目标识无效'};
  const original=browser.view?.webContents;if(!original||original.isDestroyed())return {ok:false,reason:'课程网页尚未就绪'};busy=true;let mirror,renderSession;
  try{
   let target;for(const f of frames()){if(await run(f,`!!window.__cxChapterQuiz?.parse?.().questions?.some(q=>q.key===${JSON.stringify(key)})`).catch(()=>false)){target=f;break;}}
   if(!target)return {ok:false,reason:'当前页面未找到这道题'};
   // Copy the live DOM, not extracted stems/options. Chromium renders all original
   // styles/fonts/images in an offscreen view, then captures the marked question.
   const snapshot=await run(target,`(()=>{const q=window.__cxChapterQuiz.parse().questions.find(q=>q.key===${JSON.stringify(key)});if(!q)return null;const root=document.documentElement.cloneNode(true);const originals=[...document.querySelectorAll('.TiMu')],index=originals.indexOf(q.el);const marked=root.querySelectorAll('.TiMu')[index];if(!marked)return null;marked.setAttribute('data-cx-native-capture','true');const actualCanvases=[...q.el.querySelectorAll('canvas')],copies=[...marked.querySelectorAll('canvas')];for(let i=0;i<copies.length;i++){const img=document.createElement('img');img.src=actualCanvases[i].toDataURL();img.width=actualCanvases[i].width;img.height=actualCanvases[i].height;copies[i].replaceWith(img)}for(const e of root.querySelectorAll('script,iframe,frame,object,embed,input[type=password],input[type=hidden]'))e.remove();for(const e of root.querySelectorAll('*'))for(const a of [...e.attributes])if(/^on/i.test(a.name)||a.name==='action'||a.name==='formaction')e.removeAttribute(a.name);const base=document.createElement('base');base.href=location.href;root.querySelector('base')?.remove();root.querySelector('head').prepend(base);return {html:'<!doctype html>'+root.outerHTML,width:innerWidth}})()`);
   if(!snapshot)return {ok:false,reason:'题目页面已变化'};
   renderSession=session.fromPartition('question-render-'+process.pid);
   const url=target.url;
   await renderSession.protocol.handle('https',async req=>{
    if(new URL(req.url).href===new URL(url).href)return new Response(snapshot.html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'"}});
    if(!isAllowedNavigationUrl(req.url)||req.method!=='GET')return new Response('',{status:403});
    try{return await original.session.fetch(req.url,{headers:{Referer:url},signal:AbortSignal.timeout(5000)})}catch{return new Response('',{status:502})}
   });
   mirror=new BrowserWindow({show:false,width:Math.max(320,Math.ceil(snapshot.width)),height:3000,webPreferences:{offscreen:true,session:renderSession,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
   mirror.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   mirror.webContents.on('will-navigate',(event,next)=>{if(next!==url)event.preventDefault()});
   await bounded(mirror.loadURL(url),10000);
   const rect=await bounded(mirror.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;const q=document.querySelector('[data-cx-native-capture]');if(!q)return null;for(const img of q.querySelectorAll('img')){if(!img.complete)await img.decode().catch(()=>{});if(!img.naturalWidth)throw new Error('question-image-unavailable')}q.scrollIntoView({block:'center',inline:'nearest'});const r=q.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,true),5000);
   if(!rect?.width||rect.x<0||rect.y<0||rect.y+rect.height>3000||rect.x+rect.width>mirror.getContentBounds().width+1)return {ok:false,reason:'题目未完整显示，已停止识别以免漏题'};
   const image=await bounded(mirror.webContents.capturePage({x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)},{stayHidden:false,stayAwake:true}),5000);
   if(image.isEmpty())return {ok:false,reason:'浏览器题目截图为空'};let result=image;const size=image.getSize();if(Math.max(size.width,size.height)>4096){const scale=4096/Math.max(size.width,size.height);result=image.resize({width:Math.floor(size.width*scale),height:Math.floor(size.height*scale)})}
   return {ok:true,dataUrl:result.toDataURL(),width:result.getSize().width,height:result.getSize().height,source:'browser-screenshot'};
  }catch(error){return {ok:false,reason:error.message==='capture-timeout'?'题目截图超时，请重新打开本章习题':'题目页面或图片尚未加载完成，截图已停止'};}finally{mirror?.destroy();if(renderSession)await renderSession.protocol.unhandle('https');busy=false;}
 }
 return {capture};
}
module.exports={createQuestionCapture};
