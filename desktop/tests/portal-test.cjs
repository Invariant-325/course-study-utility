const {app,BrowserWindow,WebContentsView}=require('electron');const assert=require('node:assert/strict');const http=require('node:http');const {createCoursePortal}=require('../course-portal.cjs');
app.commandLine.appendSwitch('host-resolver-rules','MAP unit.chaoxing.com 127.0.0.1');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');const u=new URL(req.url,'http://unit.chaoxing.com');
 if(u.pathname==='/visit/courses'){const page=u.searchParams.get('page')||'1';const ids=page==='1'?[1,2]:[3];return res.end('<h2>人脸识别技术课程</h2><ul id="courseList">'+ids.map(id=>`<li id="course_${id}"><a href="/mooc-ans/visit/stucoursemiddle?courseid=${id}&clazzid=9&enc=fixture">Course ${id}</a></li>`).join('')+'</ul>'+ (page==='1'?'<a title="下一页" href="/visit/courses?page=2">Next</a>':''));}
 if(u.pathname.includes('stucoursemiddle'))return res.end('<iframe name="face" src="/face-check" width="600" height="600"></iframe>');
 if(u.pathname==='/face-check')return res.end('<h1>请扫码完成人脸验证</h1><canvas id="qrcode" width="220" height="220"></canvas><script>const c=document.getElementById("qrcode").getContext("2d");c.fillStyle="white";c.fillRect(0,0,220,220);c.fillStyle="black";for(let y=0;y<22;y++)for(let x=0;x<22;x++)if((x+y)%3)c.fillRect(x*10,y*10,10,10);</script>');
 if(u.pathname==='/mycourse/studentstudy')return res.end('<script>window.starts=0;window.state="idle";window.__cxNaturalWatchApp={tree:{},runner:{snapshot:()=>({state:window.state}),start:()=>{window.starts++;window.state="playing"}}}</script>');
 res.end('<p>No page</p>');});
app.on('window-all-closed',()=>{});
server.listen(0,'127.0.0.1',async()=>{await app.whenReady();const base='http://unit.chaoxing.com:'+server.address().port;const win=new BrowserWindow({show:false});const view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.contentView.addChildView(view);view.setBounds({x:0,y:0,width:900,height:700});view.setVisible(false);
 const browser={view,home:()=>view.webContents.loadURL(base+'/visit/courses?page=1').then(()=>({ok:true})),goto:url=>view.webContents.loadURL(url).then(()=>({ok:true})),setVisible:()=>{throw Error('Must stay hidden')}};
 const portal=createCoursePortal({browser,interval:100000});
 try{
 const list=await portal.refresh();assert.equal(list.courses.length,3);assert.equal(list.state.verification,null);assert(list.courses.every(c=>!('url'in c)));console.log('PASS background reads all paginated course cards without showing web');
 const id=list.courses[0].id;await portal.open(id);await sleep(150);await portal.tick();let st=portal.status();assert.equal(st.phase,'verification');assert(st.verification.image.startsWith('data:image/png'));console.log('PASS nested-frame QR image available in main interface state');
 await portal.start();assert.equal(portal.status().phase,'verification');
 const frame=view.webContents.mainFrame.frames[0];await frame.executeJavaScript("document.body.append('二维码已过期')");await portal.tick();assert(portal.status().verification.expired);console.log('PASS expired QR detected; start remains pending during verification');
 await frame.executeJavaScript("document.body.innerHTML='<p>Redirecting</p>'");await portal.tick();assert.equal(await view.webContents.executeJavaScript('window.starts||0'),0);console.log('PASS disappearing QR alone does not mark verification complete or start');
 await view.webContents.loadURL(base+'/mycourse/studentstudy?courseId=1');await portal.tick();assert.equal(await view.webContents.executeJavaScript('window.starts'),1);assert.equal(portal.status().verification,null);await portal.tick();assert.equal(await view.webContents.executeJavaScript('window.starts'),1);assert.equal(portal.status().phase,'running');console.log('PASS actual study page starts once after requested verification flow');
 assert.equal((await portal.refresh()).ok,false);console.log('PASS refresh refuses to interrupt running course');
 portal.close();view.webContents.close();win.destroy();server.close();app.quit();
 }catch(e){console.error(e.stack);portal.close();server.close();app.exit(1)}
});
