const {app,BrowserWindow,WebContentsView}=require('electron');
const assert=require('node:assert/strict'),http=require('node:http');
const {createCoursePortal}=require('../desktop/course-portal.cjs');
app.commandLine.appendSwitch('host-resolver-rules','MAP unit.chaoxing.com 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html;charset=utf-8');
  const path=new URL(req.url,'http://unit.chaoxing.com').pathname;
  if(path==='/visit/courses')return res.end('<ul id="courseList"><li><a href="/mycourse/stu?courseid=1&clazzid=9">Fixture</a></li></ul>');
  if(path==='/mycourse/stu')return res.end('<iframe src="/mycourse/catalog" width="900" height="700"></iframe>');
  if(path==='/mycourse/catalog')return res.end(`<p>已完成任务点：19/59</p><div class="chapter_item"><h3 onclick="parent.window.clicked='complete'" title="1.1 已完成章节">1.1 已完成章节</h3><span class="chapter-status" title="已完成"></span></div><div class="chapter_item"><h3 onclick="parent.window.clicked='pending';parent.location='/mycourse/studentstudy'" title="2.2 标题">2.2 标题</h3><span class="catalog_points">1</span></div><div class="chapter_item locked"><a href="/mycourse/studentstudy">3.1 锁定章节</a></div>`);
  if(path==='/mycourse/studentstudy')return res.end('<script>window.starts=0;window.__cxNaturalWatchApp={tree:{},runner:{snapshot:()=>({state:starts?"playing":"idle"}),start:()=>{starts++}}}</script>');
  res.end('empty');
});
app.on('window-all-closed',()=>{});
server.listen(0,'127.0.0.1',async()=>{
  await app.whenReady();const base='http://unit.chaoxing.com:'+server.address().port;
  const win=new BrowserWindow({show:false});const view=new WebContentsView({webPreferences:{sandbox:true}});win.contentView.addChildView(view);
  const browser={view,home:()=>view.webContents.loadURL(base+'/visit/courses').then(()=>({ok:true})),goto:url=>view.webContents.loadURL(url).then(()=>({ok:true}))};
  const portal=createCoursePortal({browser,interval:100000});
  try{
    const list=await portal.refresh();console.log('FIXTURE',JSON.stringify({list,url:view.webContents.getURL(),body:await view.webContents.executeJavaScript('document.body.innerText')}));await portal.open(list.courses[0].id);await pause(250);await portal.tick();
    assert.equal(portal.status().phase,'chapters');assert.equal(await view.webContents.executeJavaScript('window.clicked||null'),null);
    const overview=await portal.overview();assert(overview.ok);assert.deepEqual(overview.summary,{done:19,total:59});assert.equal(overview.items.length,3);assert.equal(overview.items[0].complete,true);assert.equal(overview.items[1].pending,1);assert(overview.items[2].locked);
    assert.equal(await view.webContents.executeJavaScript('!!window.__cxNaturalWatchApp'),false);
    console.log('PASS embedded course-home catalog and 19/59 summary read before runner exists; no automatic chapter entry');
    assert.equal((await portal.openChapter({key:'chapter-1',title:'stale title'})).ok,false);
    assert.equal((await portal.openChapter({key:'chapter-2',title:'3.1 锁定章节'})).ok,false);
    console.log('PASS stale and locked chapter clicks rejected');
    await portal.start();await pause(250);await portal.tick();
    assert(view.webContents.getURL().includes('/mycourse/studentstudy'));assert.equal(await view.webContents.executeJavaScript('window.starts'),1);
    await portal.tick();assert.equal(await view.webContents.executeJavaScript('window.starts'),1);
    console.log('PASS start clicks platform onclick-only pending chapter; real study runner starts exactly once');
    assert.equal((await portal.refresh()).ok,false);
    portal.close();view.webContents.close();win.destroy();server.close();app.quit();
  }catch(e){console.error(e.stack);portal.close();server.close();app.exit(1)}
});
