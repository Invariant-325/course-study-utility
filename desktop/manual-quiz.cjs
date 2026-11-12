const {isPlatformUrl}=require('./browser-policy.cjs');
const {cleanChapterTitle}=require('./chapter-title.cjs');
function createManualQuiz({browser,portal,playback,interval=500,timeout=30000}){
 let generation=0,state={busy:false,phase:'idle',message:''};
 function frames(){const wc=browser.view?.webContents;if(!wc||wc.isDestroyed())return [];const out=[],queue=[wc.mainFrame];while(queue.length&&out.length<100){const f=queue.shift();try{if(isPlatformUrl(f.url))out.push(f);queue.push(...f.frames)}catch{}}return out;}
 async function cancel(){generation++;for(const f of frames())await f.executeJavaScript('window.__cxChapterQuiz?.runner?.stop?.()').catch(()=>null);state={busy:false,phase:'cancelled',message:'已停止本次做题'};return {ok:true};}
 async function start(chapter){
  if(state.busy)return {ok:false,error:'正在做题，请先停止或等待完成'};
  if(!chapter?.key||!chapter?.title)return {ok:false,error:'先选择要做题的章节'};
  const token=++generation,course=portal.status().selected;
  state={busy:true,phase:'opening',message:'正在打开所选章节'};
  try{
   await playback.command('pause');if(token!==generation)return {ok:false,error:'已取消'};
   const opened=await portal.openChapter(chapter);if(!opened.ok)return opened;
   const attempted=new Set(),deadline=Date.now()+timeout;
   while(Date.now()<deadline){
    if(token!==generation||portal.status().selected!==course)return {ok:false,error:'课程已切换，本次做题已停止'};
    let matches=false;const all=frames();
    for(const f of all){const valid=await f.executeJavaScript(`(()=>{const a=window.__cxNaturalWatchApp;const name=a?.tree?.activeCatalogKey?.();return !!name&&(${cleanChapterTitle.toString()})(name)===${JSON.stringify(cleanChapterTitle(chapter.title))}})()`).catch(()=>false);if(valid){matches=true;break;}}
    if(!matches){await new Promise(r=>setTimeout(r,interval));continue;}
    for(const f of all){
     const ready=await f.executeJavaScript('!!window.__cxChapterQuiz?.runner?.isQuizPage?.()').catch(()=>false);
     if(ready){
      state={busy:true,phase:'answering',message:'正在做本章习题，完成后自动提交'};
      const result=await f.executeJavaScript(`(async()=>{const r=window.__cxChapterQuiz.runner;if(r.snapshot?.().submitted)return {ok:true,phase:'already-submitted'};return r.runAuto({submit:true,force:false})})()`,true);
      if(token!==generation)return {ok:false,error:'本次做题已停止'};
      if(!result?.ok)return {ok:false,error:'本章习题未完成，请查看课程网页'};
      state={busy:false,phase:'done',message:result.phase==='already-submitted'?'本章习题已提交，无需重复做题':'本章习题已完成并提交'};return {ok:true,message:state.message};
     }
    }
    state={busy:true,phase:'opening-quiz',message:'正在查找本章习题'};
    for(const f of all){if(attempted.has(f.url))continue;
     const clicked=await f.executeJavaScript(`(()=>{const a=window.__cxNaturalWatchApp,t=a?.tree;if(t){const jobs=t.enumerate();const work=t.findPendingWorkJobs(jobs);if(work.length&&t.openWorkJob(work[0]).ok)return true;}const nodes=[...document.querySelectorAll('a,button,[role=tab],.prev_title,.prev_white')];const node=nodes.find(e=>new RegExp('^[0-9 ]*(章节测验|本章测验|章节习题|本章习题)$').test(e.textContent.trim())&&e.getClientRects().length);if(!node)return false;node.click();return true;})()`,true).catch(()=>false);
     if(clicked){attempted.add(f.url);break;}
    }
    await new Promise(r=>setTimeout(r,interval));
   }
   return {ok:false,error:'未找到所选章节的习题，请先查看课程网页'};
  }catch{return {ok:false,error:'做题中断，请查看课程网页后重试'};}
  finally{if(token===generation&&state.busy)state={busy:false,phase:'idle',message:'本次做题已结束'};}
 }
 return {start,cancel,status:()=>({...state})};
}
module.exports={createManualQuiz};
