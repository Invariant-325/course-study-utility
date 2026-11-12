(function(root){
 function buildStudyPlan({chapters=[],strategy='auto',autoQuiz=false,autoSubmit=false,advanceOnPlatformComplete=true}={}){
  const plan=[];
  for(const c of chapters){
   if(c.state==='done'||c.complete===true)continue;
   const video=typeof c.videoDone==='boolean'?c.videoDone:Object.hasOwn(c,'videoDone')?null:(c.state==='video'?true:c.state==='quiz'||c.state==='todo'?false:null);
   const quiz=typeof c.quizDone==='boolean'?c.quizDone:Object.hasOwn(c,'quizDone')?null:(c.state==='quiz'?true:c.state==='video'||c.state==='todo'?false:null);
   const tasks=[];
   if(video===false&&strategy!=='quiz-only')tasks.push({kind:'video',name:'看 '+c.name+' 视频',sub:advanceOnPlatformComplete?'平台确认完成后，继续本章后续任务':'视频播放完后，继续本章后续任务'});
   if(quiz===false&&strategy!=='video-only')tasks.push({kind:'quiz',name:(autoQuiz?'做 ':'等待你完成 ')+c.name+' 习题',sub:autoQuiz?(autoSubmit?'完成后自动提交':'做完后等你检查并提交'):'开启自动做题，或使用“做题并提交”按钮'});
   if(strategy==='quiz-first'||strategy==='quiz-only')tasks.sort((a,b)=>(a.kind==='quiz'?-1:1)-(b.kind==='quiz'?-1:1));
   if(!tasks.length&&(video===null||quiz===null))tasks.push({kind:'check',name:'检查 '+c.name+' 的视频和习题',sub:c.pending>0?'本章还有 '+c.pending+' 项，进入后区分视频和习题':'尚未查到各项进度，先检查再决定下一步'});
   for(const task of tasks)plan.push({...task,chapterKey:c.key,state:'todo'});
  }
  return plan;
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={buildStudyPlan};else root.buildStudyPlan=buildStudyPlan;
})(typeof globalThis!=='undefined'?globalThis:this);
