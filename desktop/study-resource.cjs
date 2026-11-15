// Opens normal platform replay/reading entries; completion is always checked by the course runner.
// No watch-time reports, visibility spoofing, or completion requests are generated here.
const {isAllowedNavigationUrl}=require('./browser-policy.cjs');
const {cleanChapterTitle}=require('./chapter-title.cjs');
function createStudyResourceController({browser,win}){
 let task=null,busy=false,stopping=null;
 const frames=wc=>{const out=[],todo=wc?.mainFrame?[wc.mainFrame]:[];while(todo.length&&out.length<100){const f=todo.shift();try{if(isAllowedNavigationUrl(f.url))out.push(f);todo.push(...f.frames)}catch{}}return out};
 async function activeChapter(wc){for(const f of frames(wc)){const title=await f.executeJavaScript('window.__cxNaturalWatchApp?.tree?.activeCatalogKey?.()||""').catch(()=>'');if(title)return cleanChapterTitle(title)}return ''}
 async function pause(reason='已暂停，点击继续恢复'){
  const current=task;if(!current)return {ok:true,active:false};current.paused=true;current.pauseReason=reason;
  for(const view of browser.resourceViews(current.parent,current.initialIds,current.target))for(const f of frames(view.webContents))await f.executeJavaScript('(()=>{for(const v of document.querySelectorAll("video"))v.pause();return true})()',true).catch(()=>false);
  if(task===current&&current.kind==='reading')browser.finishStudyResource(current.parent,current.initialIds);
  return {ok:true,active:task===current,paused:true};
 }
 async function stop(){
  if(stopping)return stopping;const current=task;if(!current)return {ok:true,active:false};
  stopping=(async()=>{await pause();if(task===current){browser.finishStudyResource(current.parent,current.initialIds);task=null;}return {ok:true,active:false}})();
  try{return await stopping}finally{stopping=null}
 }
 async function status(){
  const current=task;if(!current)return {ok:true,active:false};
  if(current.parent.webContents.isDestroyed()||await activeChapter(current.parent.webContents)!==current.chapter){if(task===current)await stop();return {ok:false,active:false,error:'当前章节已切换，已停止原任务'}}
  if(task!==current)return {ok:true,active:false};
  const foreground=!win.isMinimized()&&win.isFocused()&&browser.isVisible()&&(!current.target?browser.view===current.parent:browser.view!==current.parent&&browser.resourceViews(current.parent,current.initialIds,current.target).includes(browser.view));
  let media=null;for(const view of browser.resourceViews(current.parent,current.initialIds,current.target))for(const f of frames(view.webContents)){const v=await f.executeJavaScript('(()=>{const v=[...document.querySelectorAll("video")].find(v=>v.isConnected);return v?{paused:v.paused,ended:v.ended,currentTime:Number(v.currentTime)||0,duration:Number.isFinite(v.duration)?v.duration:0}:null})()').catch(()=>null);if(v)media=v}
  if(task!==current)return {ok:true,active:false};
  return {ok:true,active:true,kind:current.kind,paused:current.paused,foreground,media,mediaEnded:media?.ended===true,reason:current.paused?current.pauseReason:current.kind==='reading'?'正在阅读，完成情况以平台记录为准':'正在观看回放，等待平台记录进度'};
 }
 async function open(request){
  if(stopping)await stopping;
  if(busy)return {ok:false,error:'正在打开课程任务'};if(!['live','reading'].includes(request.kind))return {ok:false,error:'不支持的任务类型'};
  const chapter=cleanChapterTitle(request.chapter);const parent=browser.studyView||browser.view;if(!chapter)return {ok:false,error:'章节参数无效'};for(let n=0;n<10&&await activeChapter(parent.webContents)!==chapter;n++)await new Promise(r=>setTimeout(r,200));if(await activeChapter(parent.webContents)!==chapter)return {ok:false,error:'章节已变化，请刷新后再开始'};
  if(task&&task.chapter===chapter&&task.kind===request.kind&&!task.paused)return {ok:true,active:true};
  busy=true;
  try{
   if(task)await stop();task={parent,chapter,kind:request.kind,paused:false,initialIds:browser.views().map(v=>v.webContents.id)};browser.pinStudy(parent);
   const pattern=request.kind==='live'?'/ananas/modules/live/':'/mooc-ans/coursedata/readjobv2/';let opened=false;
   for(let attempt=0;attempt<20&&!opened;attempt++){
    if(!task||task.paused||await activeChapter(parent.webContents)!==chapter){await stop();return {ok:false,error:'章节已变化或任务已暂停'};}
    for(const f of frames(parent.webContents)){
     if(!new URL(f.url).pathname.includes(pattern))continue;
     opened=await f.executeJavaScript(`(()=>{const link=document.querySelector(${JSON.stringify(request.kind==='live'?'a.liveHref':'.readZT')});if(!link||!link.getClientRects().length)return false;link.click();return true})()`,true).catch(()=>false);if(opened)break;
    }
    if(!opened)await new Promise(r=>setTimeout(r,500));
   }
   task.target=browser.view!==parent?browser.view:null;
   if(!opened){await stop();return {ok:false,error:'未找到平台提供的'+(request.kind==='live'?'回放':'阅读')+'入口'}}
   if(request.kind==='live'){
    for(let attempt=0;attempt<20;attempt++){
     if(task&&!task.target&&browser.view!==parent)task.target=browser.view;
     if(!task||task.paused)return {ok:false,error:'任务已暂停'};let found=false;
     for(const view of browser.resourceViews(task.parent,task.initialIds,task.target))for(const f of frames(view.webContents)){const started=await f.executeJavaScript('(async()=>{const v=[...document.querySelectorAll("video")].find(v=>v.isConnected);if(!v)return false;v.playbackRate=1;await v.play();return true})()',true).catch(()=>false);if(started)found=true}
     if(found)return {ok:true,active:true};await new Promise(r=>setTimeout(r,500));
    }
    await stop();return {ok:false,error:'回放播放器尚未就绪，请在网页确认回放可以正常打开'};
   }
   return {ok:true,active:true};
  }finally{busy=false}
 }
 return {status,open,pause,stop,async invoke(request={}){if(!request||typeof request!=='object')return {ok:false,error:'无效任务参数'};if(request.chapter&&task&&cleanChapterTitle(request.chapter)!==task.chapter)return {ok:false,error:'原章节任务已结束'};if(request.action==='open')return open(request);if(request.action==='status')return status();if(request.action==='pause')return pause();if(request.action==='stop'||request.action==='finish')return stop();return {ok:false,error:'无效任务操作'}}};
}
module.exports={createStudyResourceController};
