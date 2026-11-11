// Optional: performs one real model request on a synthetic question, never a course.
const { app, BrowserWindow, session, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
dialog.showErrorBox = (title, detail) => console.error(title + '\n' + detail);
const pause = ms => new Promise(r => setTimeout(r, ms));
require('../main.js');
app.whenReady().then(async () => {
  session.fromPartition('persist:chaoxing').webRequest.onBeforeRequest(
    {urls:['https://i.chaoxing.com/base*']},
    (_details,cb) => cb({cancel:true}));
  try {
    let win;
    for (let i=0;i<100;i++) {
      win=BrowserWindow.getAllWindows()[0];
      if (win && await win.webContents.executeJavaScript('!!window.__cxApp && document.readyState === "complete"').catch(()=>false)) break;
      await pause(100);
    }
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const canvas=document.createElement('canvas');canvas.width=900;canvas.height=420;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,900,420);
      ctx.fillStyle='black';ctx.font='30px Arial';
      ['Synthetic test question (single choice)','What is 2 + 2?','A. 3','B. 4','C. 5','D. 6'].forEach((s,i)=>ctx.fillText(s,30,55+i*55));
      const r=await window.__cxApp.askVision({questionId:'synthetic_live_1',imageBase64:canvas.toDataURL(),allowedLetters:['A','B','C','D']});
      return {ok:r.ok,status:r.status,error:r.error||'',answers:r.answers||[],elapsedMs:r.elapsedMs||0};
    })()`,true);
    fs.writeFileSync(path.join(app.getPath('userData'),'live-result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if (!result.ok || result.answers.join('')!=='B') process.exitCode=1;
    win.close();
  } catch(e) { console.error(e.message); app.exit(1); }
});
