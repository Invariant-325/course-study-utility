const { createHash } = require('node:crypto');
const { isPlatformUrl } = require('./browser-policy.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// These readers run in the platform's own renderer. No authentication result is
// fabricated and no course URL/signature is constructed by the application.
function readCourseLinks() {
  if (!/\/visit\/(?:interaction|courses)/i.test(location.pathname) && !document.querySelector('#courseList, .course-list, .courseList')) return [];
  return [...document.querySelectorAll('a[href]')].flatMap(a => {
    let u; try { u = new URL(a.href, location.href); } catch { return []; }
    if (!/(^|\.)(chaoxing|xuexitong)\.com$/i.test(u.hostname) || !/^https?:$/.test(u.protocol)) return [];
    if (!/\/(?:stucoursemiddle|mycourse\/stu|mycourse\/studentstudy)(?:\/|$)/i.test(u.pathname)) return [];
    if (!u.searchParams.get('courseid') && !u.searchParams.get('courseId')) return [];
    const card = a.closest('li[id^="course_"], .course, .course-card, .courseItem') || a;
    const title = card.querySelector('h3, h4, .course-name, .courseName, a[title]');
    const name = (title?.getAttribute('title') || title?.textContent || a.getAttribute('title') || a.textContent || card.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim();
    if (!name || /^(课程已结束|进入课程|查看课程)$/.test(name)) return [];
    return [{ url: u.href, name: name.slice(0, 180) }];
  });
}
function readChallenge() {
  const text = (document.body?.innerText || '').slice(0, 20000);
  const face = /人脸验证|刷脸验证|人脸采集|请[^。\n]{0,50}(?:人脸|刷脸)/.test(text) || (/face|verify/i.test(location.hostname+location.pathname) && /人脸|刷脸/.test(text));
  const login = /扫码登录|扫描二维码登录/.test(text) || (/passport|login/i.test(location.hostname+location.pathname) && /学习通扫码/.test(text));
  if (!face && !login) return null;
  const candidates = [...document.querySelectorAll('canvas, img, svg')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width >= 100 && r.width <= 700 && r.height >= 100 && r.height <= 700 && r.width/r.height > .75 && r.width/r.height < 1.3 && getComputedStyle(el).visibility !== 'hidden';
  });
  const score = el => /qr|qrcode|code|face/i.test(el.id + ' ' + el.className + ' ' + (el.parentElement?.id || '') + ' ' + (el.getAttribute('src') || '')) ? 1 : 0;
  candidates.sort((a,b) => score(b)-score(a));
  const el = candidates[0];
  let image = null;
  if (el) {
    try {
      if (el.tagName === 'CANVAS') image = el.toDataURL('image/png');
      else if (el.tagName === 'IMG' && el.complete && el.naturalWidth) {
        const canvas = document.createElement('canvas'); canvas.width = el.naturalWidth; canvas.height = el.naturalHeight;
        canvas.getContext('2d').drawImage(el, 0, 0); image = canvas.toDataURL('image/png');
      }
    } catch { /* Cross-origin images use a native screenshot fallback. */ }
  }
  const r = el?.getBoundingClientRect();
  return { kind: face ? 'face' : 'login', image, source:el?.tagName==='IMG' ? el.currentSrc || el.src : null, rect: r ? {x:r.x,y:r.y,width:r.width,height:r.height} : null,
    viewport: {width:innerWidth,height:innerHeight}, expired: /二维码已过期|二维码失效|已失效/.test(text) };
}
function enterStudyPage() {
  const a = [...document.querySelectorAll('a[href]')].find(a => {
    try { const u = new URL(a.href, location.href); return /^https?:$/.test(u.protocol) && /(^|\.)(chaoxing|xuexitong)\.com$/i.test(u.hostname) && /\/mycourse\/studentstudy(?:\/|$)/i.test(u.pathname); } catch { return false; }
  });
  if (!a) return false;
  a.click(); return true;
}

function createCoursePortal({ browser, interval = 1800 }) {
  const courses = new Map();
  let selected = '', pendingStart = false, busy = false, refreshBusy = false, stopped = false;
  let state = { phase:'loading', selected:'', verification:null, error:'', count:0 };
  const attempted = new Set();
  let openingSince=0;
  function frames() {
    const wc = browser.view?.webContents;
    if (!wc || wc.isDestroyed()) return [];
    const out = [], queue = [wc.mainFrame];
    while (queue.length && out.length < 100) { const f=queue.shift(); try { if(isPlatformUrl(f.url))out.push(f); queue.push(...f.frames); } catch {} }
    return out;
  }
  async function read(frame, fn) { let timer;try{return await Promise.race([frame.executeJavaScript('(' + fn.toString() + ')()', true),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('frame timeout')),4000)})]);}finally{clearTimeout(timer)}}
  function remember(list) {
    for (const item of list) {
      if (!isPlatformUrl(item.url)) continue;
      const u = new URL(item.url), id = createHash('sha256').update([u.searchParams.get('courseid') || u.searchParams.get('courseId'),u.searchParams.get('clazzid') || u.searchParams.get('clazzId') || ''].join(':')).digest('hex').slice(0,24);
      courses.set(id, {id,name:item.name,url:item.url});
    }
    state.count = courses.size;
  }
  async function screenshot(frame, challenge) {
    const wc = browser.view.webContents;
    let rect = {...challenge.rect}, child = frame;
    if (!rect.width) return null;
    while (child.parent) {
      const parent = child.parent;
      const offset = await parent.executeJavaScript(`(()=>{const url=${JSON.stringify(child.url)},name=${JSON.stringify(child.name || '')};const all=[...document.querySelectorAll('iframe,frame')];let matches=all.filter(e=>e.src===url||(name&&e.name===name));if(matches.length!==1&&all.length===1)matches=all;if(matches.length!==1)return null;const e=matches[0],r=e.getBoundingClientRect();return{x:r.x+e.clientLeft,y:r.y+e.clientTop}})()`);
      if (!offset) return null;
      rect.x += offset.x; rect.y += offset.y; child = parent;
    }
    const bounds=browser.view.getBounds();
    if(rect.x<0||rect.y<0||rect.x+rect.width>bounds.width||rect.y+rect.height>bounds.height)return null;
    const image = await wc.capturePage({x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)});
    return image.isEmpty() ? null : image.toDataURL();
  }
  async function tick() {
    if (busy || stopped) return; busy=true;
    try {
      const all = frames();if(all.length)state.error='';
      // The course list can be embedded in cross-origin portal frames.
      for (const frame of all) { try { remember(await read(frame,readCourseLinks)); } catch {} }
      let verification = null;
      for (const frame of all) {
        try {
          const challenge=await read(frame,readChallenge);
          if (!challenge) continue;
          if (!challenge.image && challenge.source && isPlatformUrl(challenge.source)) {
            try {
              const response=await browser.view.webContents.session.fetch(challenge.source,{headers:{Referer:frame.url},credentials:'include',signal:AbortSignal.timeout(5000)});
              const mime=(response.headers.get('content-type') || '').split(';')[0];
              if(response.ok&&/^image\/(png|jpeg|gif|webp)$/.test(mime)) {
                const bytes=Buffer.from(await response.arrayBuffer());
                if(bytes.length&&bytes.length<2*1024*1024)challenge.image='data:'+mime+';base64,'+bytes.toString('base64');
              }
            } catch { /* Fall back to the actual rendered QR area. */ }
          }
          if (!challenge.image && challenge.rect) challenge.image=await screenshot(frame,challenge);
          verification={kind:challenge.kind,image:challenge.image,expired:challenge.expired}; break;
        } catch { /* Frame can navigate during an auth callback. */ }
      }
      state.verification=verification;
      if (verification) { openingSince=Date.now();state.phase=verification.kind==='face'?'verification':'login'; return; }
      const wc=browser.view?.webContents;
      if (!wc || wc.isDestroyed()) return;
      const ready=await wc.executeJavaScript(`(()=>{const a=window.__cxNaturalWatchApp;return {mounted:!!(a?.tree&&a?.runner&&location.pathname.toLowerCase().endsWith('/mycourse/studentstudy')),state:a?.runner?.snapshot?.().state}})()`).catch(()=>({mounted:false}));
      if (ready.mounted) {
        state.phase=['playing','locating','settling','advancing','quizWait','awaitingConfirm'].includes(ready.state)?'running':'ready'; state.error='';
        if (pendingStart) {
          pendingStart=false;
          await wc.executeJavaScript('Promise.resolve(window.__cxNaturalWatchApp.runner.start()).then(()=>true)',true);
          state.phase='running';
        }
      } else if (selected) {
        state.phase='opening';
        if(Date.now()-openingSince>25000){state.phase='manual';state.error='暂未找到章节学习入口，可显示原网页完成一次课程导航';}
        for (const frame of all) {
          const key=frame.url;
          if(attempted.has(key))continue;
          if(await read(frame,enterStudyPage).catch(()=>false)) { attempted.add(key); break; }
        }
      } else state.phase=courses.size?'catalog':'login';
    } catch { state.error='后台读取暂时失败，可重新读取或显示原网页处理'; }
    finally { busy=false; }
  }
  const timer=setInterval(tick,interval); timer.unref?.();
  return {
    async list() { await tick(); return {ok:true,courses:[...courses.values()].map(({id,name})=>({id,name})),state:{...state}}; },
    status() { return {...state}; },
    async refresh() {
      if(refreshBusy)return {ok:false,error:'正在读取课程'};
      if(pendingStart||state.phase==='running')return {ok:false,error:'任务执行中，停止后再刷新课程列表'};
      refreshBusy=true;
      try {
        selected=''; state.selected=''; courses.clear();state.count=0;attempted.clear(); state.phase='loading';
        await browser.home();
        const found=new Set();
        for(let page=0;page<40;page++) {
          await sleep(650); await tick();
          const all=frames(); let next=false;
          for(const f of all) {
            if(!/\/visit\/(?:interaction|courses)/i.test(f.url))continue;
            const signature=(await read(f,readCourseLinks)).map(x=>x.url).join('|');
            if(!signature||found.has(signature))continue;found.add(signature);
            next=await f.executeJavaScript(`(()=>{const e=document.querySelector('a[title="下一页"], .pagination .next:not(.disabled), .pageNext:not(.disabled)');if(!e||e.getAttribute('aria-disabled')==='true')return false;e.click();return true})()`,true);
            if(next)break;
          }
          if(!next && (courses.size||page>14||state.verification))break;
        }
        return this.list();
      } finally {refreshBusy=false;}
    },
    async open(id) {
      const course=courses.get(String(id)); if(!course)return {ok:false,error:'课程不存在，先重新读取课程列表'};
      selected=course.id;openingSince=Date.now();state.selected=selected;pendingStart=false;attempted.clear();state.phase='opening';state.error='';state.verification=null;
      const result=await browser.goto(course.url); if(!result.ok)return result;
      await tick();return {ok:true,state:{...state}};
    },
    async start() { if(!selected)return {ok:false,error:'先从主界面选择一门课程'};pendingStart=true;await tick();return {ok:true,pending:state.phase!=='running',state:{...state}}; },
    cancelStart() { pendingStart=false; },
    close() {stopped=true;pendingStart=false;clearInterval(timer);courses.clear();state.verification=null;},
    tick,
  };
}
module.exports={createCoursePortal,readCourseLinks,readChallenge};
