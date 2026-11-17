const {isAllowedNavigationUrl}=require('./browser-policy.cjs');
const {catalogCode}=require('./page-catalog.cjs');
const {readChallenge,enterStudyPage}=require('./course-portal.cjs');
function createCourseScanner({BrowserWindow,getSession,onResult}){
 let stopped=false,running=false,window=null;const queue=[],seen=new Set();
 async function bounded(p,ms=5000){let t;try{return await Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('timeout')),ms)})])}finally{clearTimeout(t)}}
 function frames(){const out=[],todo=window?.webContents?.mainFrame?[window.webContents.mainFrame]:[];while(todo.length&&out.length<80){const f=todo.shift();try{if(isAllowedNavigationUrl(f.url))out.push(f);todo.push(...f.frames)}catch{}}return out}
 async function run(){if(running||stopped)return;running=true;try{while(queue.length&&!stopped){const c=queue.shift();let value='unknown',reason='unreadable';try{
 window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:getSession(),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 window.webContents.setAudioMuted(true);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(e,url)=>{if(!isAllowedNavigationUrl(url))e.preventDefault()});
 await bounded(window.loadURL(c.url),15000).catch(()=>null);let entered=false;
 for(let n=0;n<12&&!stopped;n++){let done=false;for(const f of frames()){
 const challenge=await bounded(f.executeJavaScript('('+readChallenge.toString()+')()')).catch(()=>null);
 if(challenge?.kind==='face'){value='yes';reason='face-required';done=true;break}if(challenge?.kind==='login'){reason='login-required';done=true;break}
 const catalog=await bounded(f.executeJavaScript(catalogCode())).catch(()=>null);
 if(catalog?.ok){value=catalog.items?.length?'yes':catalog.emptyCatalog?'none':'unknown';reason=value==='yes'?'chapters-found':'empty-catalog';done=true;break}
 if(!entered)entered=await bounded(f.executeJavaScript('('+enterStudyPage.toString()+')()',true)).catch(()=>false);
 }if(done)break;await new Promise(r=>setTimeout(r,600))}
 }catch{}finally{window?.destroy();window=null}await onResult(c,value,reason)}}finally{running=false}}
 return {enqueue(items){for(const c of items){const k=c.account+':'+c.id;if(!seen.has(k)&&isAllowedNavigationUrl(c.url)){seen.add(k);queue.push(c)}}void run()},close(){stopped=true;queue.length=0;window?.destroy();window=null}};
}
module.exports={createCourseScanner};
