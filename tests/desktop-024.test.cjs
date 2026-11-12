const assert=require('node:assert/strict'),vm=require('node:vm');
const {buildStudyPlan}=require('../desktop/ui/scripts/study-plan.js');
const {createManualQuiz}=require('../desktop/manual-quiz.cjs');
const chapters=[{key:'a',name:'1.1',state:'video'},{key:'b',name:'1.2',state:'todo'},{key:'c',name:'1.3',state:'done'},{key:'d',name:'1.4',state:'unknown'}];
const plan=opts=>buildStudyPlan({chapters,autoQuiz:true,...opts});
assert.deepEqual(plan().map(x=>x.name),['做 1.1 习题','看 1.2 视频','做 1.2 习题','检查 1.4 的视频和习题']);
assert.deepEqual(plan({strategy:'quiz-first'}).map(x=>x.kind),['quiz','quiz','video','check']);
assert.deepEqual(plan({strategy:'quiz-only'}).map(x=>x.kind),['quiz','quiz','check']);
assert.deepEqual(plan({strategy:'video-only'}).map(x=>x.kind),['video','check']);
assert(buildStudyPlan({chapters:[chapters[0]]})[0].name.startsWith('等待你完成'));
assert(plan({autoSubmit:true})[0].sub.includes('自动提交'));
console.log('PASS plan: exact task order, strategy filtering, unknown progress, quiz and submit switches');
function fixture({wrong=false,submitted=false,delay=0}={}){
 let selected='course1',stopped=0,runs=0,options=null;
 const context=vm.createContext({window:{__cxNaturalWatchApp:{tree:{activeCatalogKey:()=>wrong?'另一章':'1.1 任务点：2'}},__cxChapterQuiz:{runner:{isQuizPage:()=>true,snapshot:()=>({submitted}),stop:()=>{stopped++},runAuto:async opts=>{runs++;options=opts;if(delay)await new Promise(r=>setTimeout(r,delay));return {ok:true,phase:'submitted'}}}}}});
 const frame={url:'https://unit.chaoxing.com/mycourse/studentstudy',frames:[],executeJavaScript:async code=>vm.runInContext(code,context)};
 const portal={status:()=>({selected}),openChapter:async()=>({ok:true})};
 const controller=createManualQuiz({browser:{view:{webContents:{isDestroyed:()=>false,mainFrame:frame}}},portal,playback:{command:async()=>({ok:true})},interval:1,timeout:20});
 return {controller,info:()=>({stopped,runs,options}),setCourse:value=>{selected=value}};
}
(async()=>{
 let f=fixture();assert((await f.controller.start({key:'a',title:'1.1'})).ok);assert.equal(f.info().runs,1);assert.equal(f.info().options.submit,true);assert.equal(f.info().options.force,false);
 f=fixture({wrong:true});assert.equal((await f.controller.start({key:'a',title:'1.1'})).ok,false);assert.equal(f.info().runs,0);
 f=fixture({submitted:true});assert((await f.controller.start({key:'a',title:'1.1'})).ok);assert.equal(f.info().runs,0);
 f=fixture({delay:30});const active=f.controller.start({key:'a',title:'1.1'});await new Promise(r=>setTimeout(r,5));assert.equal((await f.controller.start({key:'a',title:'1.1'})).ok,false);await f.controller.cancel();assert.equal((await active).ok,false);assert(f.info().stopped>0);
 console.log('PASS manual quiz: selected chapter only, one-shot submit, no repeated submitted work, duplicate prevention and cancellation');
})().catch(e=>{console.error(e);process.exitCode=1});
