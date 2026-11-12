import test from 'node:test';import assert from 'node:assert/strict';import {loadEnv} from './harness.mjs';
const files=['10-log.js','20-config.js','30-selectors.js','35-urls.js','40-dom.js','50-course-tree.js','60-video.js','65-pause.js','70-state.js','80-runner.js'];
for(const cross of [false,true])test(cross?'跨域习题通过桌面桥接继续处理，不停在核对状态':'视频完成后自动打开章节测验标签并推进',async()=>{
 const e=loadEnv(files),{Runner,CourseTree,Config}=e.exports;let opened=0,answered=0,ready=false,done=false;
 Config.set('quizGateEnabled',true);Config.set('quizAutoSubmit',true);
 CourseTree.enumerateDetail=()=>({jobs:[{id:'v',type:'video',state:'finished'}],inaccessible:[],stats:{unfinished:0,finished:1,unknown:0,documentCount:1}});
 CourseTree.pickNextVideoTarget=()=>({job:null});CourseTree.readTaskTabs=()=>({quiz:true,video:true});CourseTree.currentCatalogComplete=()=>done;CourseTree.activeCatalogKey=()=> '2.2 本章';
 CourseTree.catalogProgress=()=>({ok:true,total:1,unknown:0,pending:done?0:1,items:[{active:true,pending:done?0:1}]});
 CourseTree.openQuizTab=()=>{opened++;ready=true;return {ok:true}};CourseTree.clickNextCatalogItem=()=>({ok:false,reason:'all-complete'});
 e.context.ChapterQuizRunner={isQuizPage:()=>!cross&&ready,runAuto:async opts=>{assert(opts.submit);answered++;done=true;return {ok:true,phase:'submitted'}}};
 if(cross)e.window.__cxHost={chapterQuiz:async request=>{if(request.action==='status')return {ready};if(request.action==='run'){assert(request.submit);answered++;done=true;return {ok:true,phase:'submitted'}}return {ok:true}}};
 try{Runner.start();await new Promise(r=>setTimeout(r,120));assert.equal(opened,1);assert.equal(answered,1);assert.equal(Runner.state(),'completed');}finally{Runner.stop();e.window.close()}
});
