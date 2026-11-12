import test from 'node:test';
import assert from 'node:assert/strict';
import {loadEnv} from './harness.mjs';
const files=['10-log.js','20-config.js','30-selectors.js','35-urls.js','40-dom.js','50-course-tree.js','60-video.js','65-pause.js','70-state.js','80-runner.js'];
test('提前结束视频须平台确认；百分比不作完成证据，关闭选项时继续播放',async()=>{
 const e=loadEnv(files);const {Runner,CourseTree,Config}=e.exports;let paused=0;
 const container=e.document.createElement('div');container.innerHTML='<span class="ans-job-icon" aria-label="任务点未完成"></span>';e.document.body.append(container);
 const job={id:'video',stableKey:'video',title:'Video',type:'video',state:'unfinished',container};
 const video=e.document.createElement('video');container.append(video);video.play=async()=>{};video.pause=()=>{paused++};Object.defineProperty(video,'duration',{get:()=>100});video.currentTime=90;
 CourseTree.enumerateDetail=()=>({jobs:[job],inaccessible:[],stats:{unfinished:1,unknown:0,finished:0,documentCount:1}});CourseTree.pickNextVideoTarget=()=>({job});CourseTree.findVideoInJob=()=>video;
 try{
  Runner.start();await new Promise(r=>setTimeout(r,50));await Runner.refreshProgress(false);assert.equal(paused,0);
  container.querySelector('span').setAttribute('aria-label','任务点已完成');Config.set('advanceOnPlatformComplete',false);await Runner.refreshProgress(false);assert.equal(paused,0);
  Config.set('advanceOnPlatformComplete',true);await Runner.refreshProgress(false);assert.equal(paused,1);assert.equal(Runner.state(),'advancing');
 }finally{Runner.stop();e.window.close()}
});
test('默认自动策略，本章仍有测验时不得跳到后章',async()=>{
 const e=loadEnv(files);const {Config,Runner,CourseTree}=e.exports;let advanced=0;
 assert.equal(Config.get('studyStrategy'),'auto');
 CourseTree.enumerateDetail=()=>({jobs:[{id:'work',state:'unfinished',type:'work'}],inaccessible:[],stats:{unfinished:1,unknown:0,finished:0,documentCount:1}});
 CourseTree.pickNextVideoTarget=()=>({job:null});CourseTree.catalogProgress=()=>({items:[{active:true,pending:1}],ok:true,unknown:0,pending:1});CourseTree.clickNextCatalogItem=()=>{advanced++;return {ok:true}};
 try{Runner.start();await new Promise(r=>setTimeout(r,1200));assert.equal(advanced,0);assert.equal(Runner.state(),'awaitingConfirm');assert.match(Runner.snapshot().awaitingReason,/自动做题已关闭/);}finally{Runner.stop();e.window.close()}
});
test('网页切章后解除旧自动调度而不暂停新播放器',async()=>{
 const e=loadEnv(files);const {Runner,CourseTree,VideoCtl}=e.exports;let active='第一章',paused=0;
 CourseTree.catalogProgress=()=>({items:[{active:true,text:active}],ok:true,unknown:0,pending:1});
 // Start in a real video task, then change the catalog identity observed by reconcile.
 const job={id:'video',stableKey:'video',title:'Video',type:'video',state:'unfinished',container:e.document.createElement('div')};e.document.body.append(job.container);
 const video=e.document.createElement('video');job.container.append(video);video.play=async()=>{};video.pause=()=>{paused++};
 CourseTree.enumerateDetail=()=>({jobs:[job],inaccessible:[],stats:{unfinished:1,unknown:0,finished:0,documentCount:1}});CourseTree.pickNextVideoTarget=()=>({job});CourseTree.findVideoInJob=()=>video;
 try{Runner.start();await new Promise(r=>setTimeout(r,60));active='第二章';Runner.reconcilePlayback();assert.equal(Runner.state(),'stopped');assert.equal(paused,0);}finally{Runner.stop();e.window.close()}
});
test('服务端已完成覆盖旧目录待完成，未知条目不盲目点击',async()=>{
 const e=loadEnv(files,{html:'<div id="coursetree"><div class="posCatalog_select posCatalog_active"><span class="posCatalog_name">本节</span><span>2个待完成任务点</span></div><div class="posCatalog_select"><span class="posCatalog_name">下一节</span></div></div>'});
 try{
  e.window.fetch=async()=>({ok:true,text:async()=>'<div class="posCatalog_select posCatalog_active"><span class="posCatalog_name">本节</span><span>0个待完成任务点</span></div><p>已完成任务点：59/59</p>'});
  const result=await e.exports.CourseTree.refreshCatalog(true);assert(result.ok);
  assert.equal(e.exports.CourseTree.readCatalogPending(e.document.querySelector('.posCatalog_select')),0);
  assert.equal(e.exports.CourseTree.currentCatalogComplete(),true);
  assert.equal(e.exports.CourseTree.readCatalogSummary().done,59);
  assert.equal(e.exports.CourseTree.clickNextCatalogItem().reason,'unverified-catalog');
 }finally{e.window.close()}
});
for(const strategy of ['auto','quiz-first','quiz-only'])test(strategy+' 优先回到前面未完成章节，跳过已完成章节',()=>{
 const e=loadEnv(files,{html:'<div id="coursetree">'+['前面待补','已完成','当前','后面待补'].map((n,i)=>'<div class="posCatalog_select '+(i===2?'posCatalog_active':'')+'"><span class="posCatalog_name">'+n+'</span><span>'+(i===1?0:1)+'个待完成任务点</span></div>').join('')+'</div>'});
 try{e.exports.Config.set('studyStrategy',strategy);let clicked='';e.document.querySelectorAll('.posCatalog_name').forEach(el=>el.addEventListener('click',()=>clicked=el.textContent));assert(e.exports.CourseTree.clickNextCatalogItem().ok);assert.equal(clicked,'前面待补');}finally{e.window.close()}
});
test('仅补测验不会选择未完成视频，没有开启做题时明确停止',async()=>{
 const e=loadEnv(files);let picks=0;e.exports.Config.set('studyStrategy','quiz-only');e.exports.CourseTree.pickNextVideoTarget=()=>{picks++;return {job:{}}};
 try{e.exports.Runner.start();await new Promise(r=>setTimeout(r,50));assert.equal(picks,0);assert.equal(e.exports.Runner.state(),'blocked');}finally{e.exports.Runner.stop();e.window.close()}
});
