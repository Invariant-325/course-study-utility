import test from 'node:test';
import assert from 'node:assert/strict';
import {loadEnv} from './harness.mjs';

const files=['10-log.js','20-config.js','30-selectors.js','35-urls.js','40-dom.js','50-course-tree.js','60-video.js','65-pause.js','70-state.js','80-runner.js'];
for (const onQuizPage of [false,true]) {
  test(onQuizPage ? '章节测验识别失败后进入人工确认' : '章节测验找不到入口后进入人工确认', async()=>{
    const env=loadEnv(files);
    const {CourseTree,Runner,Config}=env.exports;
    // 闸门默认已改为关闭（由面板「自动做题」开关控制），这里显式打开以覆盖闸门行为
    Config.load();
    Config.set('quizGateEnabled',true);
    const work={id:'work-qa',stableKey:'qa/work',type:'work',state:'unfinished',title:'fixture quiz'};
    CourseTree.enumerateDetail=()=>({jobs:[work],inaccessible:[],documents:[{doc:env.document}],stats:{unfinished:1,finished:0,unknown:0,documentCount:1}});
    CourseTree.pickNextVideoTarget=()=>({job:null});
    CourseTree.signatureOf=()=> 'fixture-work';
    CourseTree.findPendingWorkJobs=()=>[work];
    CourseTree.openWorkJob=()=>({ok:false,reason:'fixture-no-entry'});
    env.context.ChapterQuizRunner={isQuizPage:()=>onQuizPage,runAuto:async()=>({ok:false,phase:'analyze',error:'fixture-unreadable'})};
    try {
      Runner.start();
      await new Promise(r=>setTimeout(r,70));
      assert.equal(Runner.state(),'awaitingConfirm');
      assert.equal(Runner.snapshot().noteReason,'chapter-quiz-manual');
    } finally {Runner.stop();env.window.close();}
  });
}
