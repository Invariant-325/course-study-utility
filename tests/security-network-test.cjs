const {app,BrowserWindow,WebContentsView,session}=require('electron');
const assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const {createCourseBrowser}=require('../desktop/course-browser.cjs');
const {isAllowedNavigationUrl:allowed}=require('../desktop/browser-policy.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.on('window-all-closed',()=>{});
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('host-resolver-rules','MAP unit.chaoxing.com 127.0.0.1, MAP evil.test 127.0.0.1');
const cert=fs.readFileSync(path.join(__dirname,'test-cert.pem'),'utf8');const requests=[];
const server=https.createServer({cert,key:fs.readFileSync(path.join(__dirname,'test-key.pem'))},(req,res)=>{
  requests.push({host:req.headers.host,path:req.url});
  if(req.url==='/redirect'){res.writeHead(302,{Location:'https://evil.test/redirected'});return res.end();}
  res.setHeader('Content-Type','text/html');res.end('<h1>Trusted fixture</h1>');
});
server.on('error',e=>{console.error(e);app.exit(1)});
server.listen(443,'127.0.0.1',async()=>{
 await app.whenReady();let ses=session.fromPartition('network-security-test');let win=new BrowserWindow({show:false});const logs=[];
 let browser=createCourseBrowser({win,WebContentsView,ses,inject:()=>{},log:x=>logs.push(x)});
 try{
  const initial=await browser.goto('https://unit.chaoxing.com/course');assert.equal(initial.ok,false);assert(logs.includes('certificate-rejected'));assert.equal(requests.length,0);
  console.log('PASS real TLS: allowed hostname with untrusted certificate rejected before HTTP request');
  // Trust exactly this fixture certificate in this in-memory test partition only.
  browser.close();win.destroy();ses=session.fromPartition('network-security-trusted-fixture');win=new BrowserWindow({show:false});
  ses.setCertificateVerifyProc((request,callback)=>{const {X509Certificate}=require('node:crypto');let match=false;try{match=new X509Certificate(request.certificate.data).raw.equals(new X509Certificate(cert).raw)}catch{}callback(match?0:-2)});
  browser=createCourseBrowser({win,WebContentsView,ses,inject:()=>{},log:x=>logs.push(x)});
  const loaded=await browser.goto('https://unit.chaoxing.com/course');console.log('TRUSTED FIXTURE',JSON.stringify(loaded));assert(loaded.ok);const wc=browser.view.webContents;
  const bad=['http://unit.chaoxing.com/x','https://chaoxing.com.evil.test','https://evilchaoxing.com','https://chaoxing.com@evil.test','https://evil.test@chaoxing.com','https://127.0.0.1','https://chaoxing.com:8443','javascript:alert(1)','file:///C:/Windows/win.ini','data:text/html,test','https://chaoxing.com./'];
  for(const url of bad){assert.equal(allowed(url),false,url);assert.equal((await browser.goto(url)).ok,false);}
  console.log('PASS HTTPS hostname, userinfo, port, IP, lookalike and scheme checks');
  await wc.executeJavaScript(`location.href='https://evil.test/navigation';true`);await pause(200);assert.equal(wc.getURL(),'https://unit.chaoxing.com/course');
  await wc.executeJavaScript(`window.open('https://evil.test/popup');true`);await pause(100);
  await wc.executeJavaScript(`const f=document.createElement('iframe');f.src='https://evil.test/frame';document.body.append(f);true`);await pause(200);
  assert(!requests.some(r=>r.host==='evil.test'));
  console.log('PASS links, popup and iframe cannot load foreign host');
  await wc.loadURL('https://evil.test/programmatic').catch(()=>{});assert(!requests.some(r=>r.host==='evil.test'));
  await browser.goto('https://unit.chaoxing.com/redirect');await pause(200);assert(!requests.some(r=>r.host==='evil.test'));
  console.log('PASS direct loadURL and HTTP 302 redirect blocked before destination request');
  await browser.goto('https://unit.chaoxing.com/course');
  await wc.executeJavaScript(`window.open('about:blank').location='https://unit.chaoxing.com/popup';true`);await pause(300);
  assert(requests.some(r=>r.path==='/popup'));assert.equal(browser.view.webContents.getURL(),'https://unit.chaoxing.com/popup');
  console.log('PASS trusted about:blank popup can continue normal platform navigation');
  browser.close();win.destroy();server.close();app.quit();
 }catch(e){console.error(e.stack);browser.close();win.destroy();server.close();app.exit(1)}
});
