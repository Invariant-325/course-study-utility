const {isPlatformUrl}=require('./browser-policy.cjs');
const {cleanChapterTitle}=require('./chapter-title.cjs');
function createChapterQuizBridge({browser,getPreferences}){
 let busy=false,generation=0;
 function frames(){const root=browser.view?.webContents?.mainFrame;const out=[],queue=root?[root]:[];while(queue.length&&out.length<100){const f=queue.shift();try{if(isPlatformUrl(f.url))out.push(f);queue.push(...f.frames)}catch{}}return out;}
 async function invoke(request={}){
  if(!['status','run','stop','tabs','open'].includes(request.action))return {ok:false,error:'不支持的习题操作'};
  const all=frames();
  if(request.action==='stop'){generation++;for(const f of all)await f.executeJavaScript('window.__cxChapterQuiz?.runner?.stop?.()').catch(()=>null);return {ok:true};}
  const chapter=cleanChapterTitle(request.chapter);let active=false;
  for(const f of all){const title=await f.executeJavaScript('window.__cxNaturalWatchApp?.tree?.activeCatalogKey?.()||""').catch(()=>'');if(title&&cleanChapterTitle(title)===chapter){active=true;break;}}
  if(!active)return {ok:false,ready:false,error:'当前章节已切换，已取消本次做题'};
  if(request.action==='tabs'||request.action==='open'){
   const tabs={video:false,quiz:false};
   for(const f of all){const result=await f.executeJavaScript(`(()=>{const nodes=[...document.querySelectorAll('a,button,[role=tab],.prev_white,.prev_title,.prev_list li')];const text=e=>e.textContent.replace(/\\s+/g,'').trim();const quiz=nodes.find(e=>/^\\d*(章节测验|本章测验|章节习题|本章习题)$/.test(text(e))&&e.getClientRects().length);const video=nodes.some(e=>/^\\d*(课程视频|本章视频)$/.test(text(e)));if(${request.action==='open'}&&quiz){quiz.click();return {video,quiz:true,opened:true}}return {video,quiz:!!quiz,opened:false}})()`,true).catch(()=>null);if(result){tabs.video||=result.video;tabs.quiz||=result.quiz;if(result.opened)return {ok:true,opened:true,tabs};}}
   return {ok:true,opened:false,tabs};
  }
  let target;for(const f of all){const ready=await f.executeJavaScript('!!(window.__cxChapterQuiz?.detect?.().isQuizPage&&window.__cxChapterQuiz?.parse?.().count)').catch(()=>false);if(ready){target=f;break;}}
  if(!target)return {ok:true,ready:false};
  if(request.action==='status')return {ok:true,ready:true};
  if(busy)return {ok:false,error:'本章习题正在处理'};
  const prefs=getPreferences();if(!prefs.quizGateEnabled)return {ok:false,error:'自动做题已关闭'};
  busy=true;const token=generation;
  try{const result=await target.executeJavaScript(`window.__cxChapterQuiz.runner.runAuto({submit:${request.submit===true&&prefs.quizAutoSubmit===true},force:false,confirmTimeoutMs:8000})`,true);return token===generation?result:{ok:false,error:'本次做题已停止'};}catch{return {ok:false,error:'习题页面已变化，请重新打开习题'};}finally{busy=false;}
 }
 return {invoke};
}
module.exports={createChapterQuizBridge};
