const {app,BrowserWindow,webContents,session,dialog}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));dialog.showErrorBox=(title,message)=>console.error(title,message);
require('../desktop/main.js');
app.whenReady().then(async()=>{try{
 const ses=session.fromPartition('persist:chaoxing');
 await ses.protocol.handle('https',req=>{
  const url=new URL(req.url);let html;
  if(url.hostname==='quiz.chaoxing.com')html=`<script>window.__cxUserscriptLoaded=true;window.__cxChapterQuiz={detect:()=>({isQuizPage:true}),parse:()=>({count:1}),runner:{runAuto:async options=>({ok:true,phase:options.submit?'submitted':'filled',receivedSubmit:options.submit}),stop:()=>true}};</script>`;
  else if(url.pathname==='/base')html='<span id="personalName">Fixture User</span><ul id="courseList"><li><a href="/mycourse/stu?courseid=1&clazzid=9">Integration course</a></li></ul>';
  else if(url.pathname==='/mycourse/stu')html='<iframe src="/mycourse/catalog"></iframe>';
  else if(url.pathname==='/mycourse/catalog')html='<p>已完成任务点：19/59</p><div class="chapter_item"><h3 onclick="parent.location=\'/mycourse/studentstudy\'" title="1.1 章节标题">1.1 章节标题</h3><span class="catalog_points">2</span></div>';
  else html=`<script>window.__cxUserscriptLoaded=true;window.starts=0;window.__cxNaturalWatchApp={tree:{catalogEntries:()=>({items:[]}),catalogProgress:()=>({items:[]}),enumerate:()=>[],readCatalogSummary:()=>null},runner:{snapshot:()=>({state:starts?'playing':'idle'}),start:()=>{starts++}}}</script>`;
  return new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8'}});
 });
 await ses.cookies.set({url:'https://i.chaoxing.com',name:'_uid',value:'fixture-user',secure:true,expirationDate:Date.now()/1000+3600});
 let win;for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows()[0];if(win&&await win.webContents.executeJavaScript('!!window.__cxApp').catch(()=>false))break;await pause(100)}
 const ui=code=>win.webContents.executeJavaScript(code,true);let list;
 for(let i=0;i<100;i++){list=await ui('window.__cxApp.coursesList()');if(list.courses?.length)break;await pause(100)}
 assert.equal(list.courses.length,1);await ui('window.__cxApp.courseOpen('+JSON.stringify(list.courses[0].id)+')');await pause(200);
 const overview=await ui('window.__cxApp.courseOverview()');assert(overview.data.ok);assert.equal(overview.data.items[0].title,'1.1 章节标题');assert.deepEqual(overview.data.summary,{done:19,total:59});
 list=await ui('window.__cxApp.coursesList()');assert.deepEqual(list.courses[0].progress.summary,{done:19,total:59});
 console.log('PASS actual main/preload fallback reads course homepage and persists genuine summary without runner');
 const catalogWeb=webContents.getAllWebContents().find(w=>w!==win.webContents&&w.getURL().includes('/mycourse/stu'));
 assert(catalogWeb);await ui('window.courseUpdates=0;window.__cxApp.onCourseChanged(()=>window.courseUpdates++);true');
 const catalogFrame=catalogWeb.mainFrame.frames.find(f=>f.url.includes('/mycourse/catalog'));assert(catalogFrame);
 await catalogFrame.executeJavaScript(`document.querySelector('.catalog_points').setAttribute('aria-label','0个待完成任务点');document.querySelector('.catalog_points').textContent='0';true`);
 await pause(350);assert((await ui('window.courseUpdates'))>0,'directory mutation must notify UI immediately');
 const updated=await ui('window.__cxApp.courseOverview()');assert.equal(updated.data.items[0].pending,0);assert.equal(updated.data.items[0].complete,true);
 await catalogFrame.executeJavaScript(`document.querySelector('.catalog_points').textContent='2';document.querySelector('.catalog_points').removeAttribute('aria-label');true`);
 console.log('PASS actual main overview immediately reads directory DOM mutations without refresh click');

 await ui('window.__cxApp.courseStart()');await pause(200);await ui('window.__cxApp.coursesList()');
 let web;for(let i=0;i<50;i++){await ui('window.__cxApp.coursesList()');web=webContents.getAllWebContents().find(w=>w!==win.webContents&&w.getURL().includes('/mycourse/studentstudy'));if(web&&await web.executeJavaScript('window.starts')===1)break;await pause(100)}assert(web);console.log('STATE',JSON.stringify(await ui('window.__cxApp.courseStatus()')),await web.executeJavaScript('JSON.stringify({mounted:!!window.__cxNaturalWatchApp?.tree,path:location.pathname,state:window.__cxNaturalWatchApp?.runner?.snapshot()})'));assert.equal(await web.executeJavaScript('window.starts'),1);
 assert((await ui('window.__cxApp.evalMain("!!window.__cxNaturalWatchApp.runner")')).result);
 const blocked=await ui('window.__cxApp.goto("https://evil.test/")');assert.equal(blocked.ok,false);
 console.log('PASS UI start enters chapter, main runner bridge works, and main goto rejects foreign URL');
 const preferences=await ui('window.__cxApp.learningPreferences({quizGateEnabled:true,quizAutoSubmit:true,studyStrategy:"quiz-first",advanceOnPlatformComplete:false})');assert(preferences.quizGateEnabled&&preferences.quizAutoSubmit);assert.equal(preferences.studyStrategy,'quiz-first');
 const reloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await reloaded;await pause(250);
 assert.equal(await ui('document.getElementById("swAutoQuiz").checked'),true);assert.equal(await ui('document.getElementById("swAutoSubmit").checked'),true);assert.equal(await ui('document.getElementById("studyStrategy").value'),'quiz-first');
 assert.equal(await ui('document.getElementById("advanceOnPlatformComplete").checked'),false);
 console.log('PASS persisted quiz/submit switches and strategy restored after renderer reload');
 assert.equal(await ui('document.getElementById("workspaceStrategy").value'),'quiz-first');await ui('document.getElementById("workspaceStrategy").value="video-only";document.getElementById("workspaceStrategy").dispatchEvent(new Event("change"));true');await pause(200);assert.equal((await ui('window.__cxApp.learningPreferences()')).studyStrategy,'video-only');assert.equal(await ui('document.getElementById("studyStrategy").value'),'video-only');console.log('PASS course strategy shortcut persists through actual main/preload IPC');
 const scheduled=await ui('window.__cxApp.nightSchedule(30000)');assert(scheduled.ok);assert((await ui('window.__cxApp.nightStatus()')).preventingSleep);assert(scheduled.executeAt-Date.now()>29000);assert((await ui('window.__cxApp.nightStatus()')).pending);
 await ui('window.__cxApp.nightCancel()');assert.equal((await ui('window.__cxApp.nightStatus()')).pending,false);
 console.log('PASS real night IPC schedules 30 seconds and cancels immediately; monitor command never executes');
 await web.executeJavaScript(`window.__cxNaturalWatchApp.tree.activeCatalogKey=()=> '2.2 当前章节';const tab=document.createElement('button');tab.className='prev_title';tab.textContent='2 章节测验';tab.onclick=()=>{window.quizTabOpened=true};document.body.append(tab);const quizFrame=document.createElement('iframe');quizFrame.src='https://quiz.chaoxing.com/work/doHomeWorkNew';document.body.append(quizFrame);true`);await pause(350);
 await ui('window.__cxApp.learningPreferences({quizGateEnabled:true,quizAutoSubmit:false})');
 const tabs=await ui('window.__cxApp.evalMain('+JSON.stringify('window.__cxHost.chapterQuiz({action:"tabs",chapter:"2.2 当前章节"})')+')');assert(tabs.result.tabs.quiz);const opened=await ui('window.__cxApp.evalMain('+JSON.stringify('window.__cxHost.chapterQuiz({action:"open",chapter:"2.2 当前章节"})')+')');assert(opened.result.opened);assert(await web.executeJavaScript('window.quizTabOpened'));
 const quizStatus=await ui('window.__cxApp.evalMain('+JSON.stringify('window.__cxHost.chapterQuiz({action:"status",chapter:"2.2 当前章节"})')+')');assert(quizStatus.result.ready);
 const quizRun=await ui('window.__cxApp.evalMain('+JSON.stringify('window.__cxHost.chapterQuiz({action:"run",chapter:"2.2 当前章节",submit:true})')+')');assert.equal(quizRun.result.phase,'filled');assert.equal(quizRun.result.receivedSubmit,false);
 const wrong=await ui('window.__cxApp.evalMain('+JSON.stringify('window.__cxHost.chapterQuiz({action:"run",chapter:"另一章节",submit:true})')+')');assert.equal(wrong.result.ok,false);
 console.log('PASS real main/preload cross-origin quiz bridge, selected-chapter guard and global submit-off respected');
 await pause(300);const store=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'store.json')));assert(store.courseProgressByAccount);
 await ui('setTimeout(()=>window.__cxApp.windowControl("quit"),100);true');
 }catch(e){console.error(e.stack);app.exit(1)}});
