const {isPlatformUrl}=require('./browser-policy.cjs');
function inspectPlayback(){
 const a=window.__cxNaturalWatchApp;a?.runner?.reconcilePlayback?.();
 let snap=null;try{snap=a?.runner?.snapshot?.()||null}catch{}
 const videos=[...document.querySelectorAll('video')].filter(v=>v.isConnected&&v.getBoundingClientRect().width>0);
 const video=videos.find(v=>!v.paused&&!v.ended)||videos[0];
 return {runner:snap,video:video?{paused:video.paused,ended:video.ended,currentTime:Number(video.currentTime)||0,duration:Number.isFinite(video.duration)?video.duration:0}:null};
}
function createPlaybackController({browser,portal}){
 let busy=false;
 function frames(){const root=browser.view?.webContents?.mainFrame;if(!root)return [];const all=[],queue=[root];while(queue.length&&all.length<100){const frame=queue.shift();try{if(isPlatformUrl(frame.url))all.push(frame);queue.push(...frame.frames)}catch{}}return all;}
 async function status(){
  const values=[];for(const frame of frames()){try{values.push(await frame.executeJavaScript('('+inspectPlayback.toString()+')()'))}catch{}}
  const runner=values.map(v=>v.runner).find(Boolean)||null;
  const video=values.map(v=>v.video).find(v=>v&&!v.paused&&!v.ended)||values.map(v=>v.video).find(Boolean)||runner?.video||null;
  const state=runner?.state||'idle',pending=portal.status().pendingStart;
  const mode=video&&!video.paused&&!video.ended?'playing':pending?'preparing':['locating','settling','advancing'].includes(state)?'preparing':video?.paused&&!video.ended&&state==='playing'?'paused':state==='playing'?'playing':['paused','blocked','needsReview'].includes(state)?'paused':state==='quizWait'&&runner?.running?'working':['quizWait','awaitingConfirm'].includes(state)?'waiting':'idle';
  return {ok:true,runner,video,mode,busy};
 }
 async function command(action){
  if(busy)return {ok:false,error:'操作正在执行'};
  if(!['start','resume','pause','stop'].includes(action))return {ok:false,error:'无效操作'};
  busy=true;
  try{
   if(action==='pause'||action==='stop'){
    portal.cancelStart();
    for(const frame of frames())await frame.executeJavaScript(`(()=>{const r=window.__cxNaturalWatchApp?.runner;if(r){if(${JSON.stringify(action)}==='pause'){if(r.pause?.()===false)r.stop?.();}else r.stop?.();}for(const v of document.querySelectorAll('video'))v.pause();return true})()`,true).catch(()=>false);
    return {ok:true};
   }
   for(const frame of frames()){
    const result=await frame.executeJavaScript(`(()=>{const r=window.__cxNaturalWatchApp?.runner;if(!r)return null;const s=r.snapshot();const method=['paused','blocked','awaitingConfirm','needsReview','quizWait'].includes(s.state)?'resume':'start';if(s.running&&s.state==='playing'){const v=document.querySelector('video');if(v?.paused){r.pause();return {ok:r.resume()!==false};}return {ok:true,alreadyRunning:true};}return {ok:r[method]()!==false};})()`,true).catch(()=>null);
    if(result)return result.ok?result:{ok:false,error:'当前任务状态不允许启动，先查看异常提示'};
   }
   return await portal.start();
  }finally{busy=false;}
 }
 return {status,command};
}
module.exports={createPlaybackController};
