const { createHash } = require('node:crypto');
const { isPlatformUrl } = require('./browser-policy.cjs');
const { catalogCode,refreshCatalogCode } = require('./page-catalog.cjs');
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
    const img=card.querySelector('img');let cover=img?.currentSrc||img?.getAttribute('data-original')||img?.getAttribute('data-src')||img?.src||'';try{if(cover)cover=new URL(cover,location.href).href}catch{cover=''};return [{ url: u.href, name: name.slice(0, 180),cover }];
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

function createCoursePortal({ browser, interval = 1800,onActivity=()=>{},getStrategy=()=> 'auto' }) {
  const courses = new Map();
  let profile={name:'',avatar:''};
  let selected = '', pendingStart = false, busy = false, refreshBusy = false, stopped = false;
  let state = { phase:'loading', selected:'', verification:null, error:'', count:0 };
  const attempted = new Map();
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
      courses.set(id, {id,name:item.name,url:item.url,cover:isPlatformUrl(item.cover)?item.cover:''});
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
      for(const frame of all){if(!/^https?:\/\/i\.chaoxing\.com(?:[:/]|$)/.test(frame.url))continue;
        try{const p=await frame.executeJavaScript(`(()=>{const e=document.querySelector('#personalName,.personalName,.user-name,#userName,#username,#space_nickname,.userInfo .name,.user-info .name');let name=(e?.textContent||e?.getAttribute('title')||'').trim();if(!name){const m=(document.body?.innerText||'').match(/账号[：:]\\s*([^\\n]{1,40})/);if(m)name=m[1].trim()}const img=document.querySelector('#userPhoto,.personalHead img,.personalPic img,.userInfo img,.user-info img,img[id*=head],img[class*=avatar],img[src*=portrait],img[src*=photo]');return{name:name.slice(0,60),avatar:img?.currentSrc||img?.src||''}})()`);if(p.name)profile={name:p.name,avatar:isPlatformUrl(p.avatar)?p.avatar:''};}catch{}}

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
      if (verification) { onActivity(false);openingSince=Date.now();state.phase=verification.kind==='face'?'verification':'login'; return; }
      const wc=browser.view?.webContents;
      if (!wc || wc.isDestroyed()) return;
      let ready={mounted:false},studyFrame=null;
      for(const frame of all){
        const value=await frame.executeJavaScript(`(()=>{const a=window.__cxNaturalWatchApp;return {mounted:!!(a?.tree&&a?.runner&&location.pathname.toLowerCase().endsWith('/mycourse/studentstudy')),state:a?.runner?.snapshot?.().state}})()`).catch(()=>({mounted:false}));
        if(value.mounted){ready=value;studyFrame=frame;break;}
      }
      if (ready.mounted) {
        await studyFrame.executeJavaScript('Promise.resolve(window.__cxNaturalWatchApp.runner.refreshProgress?.(false))',true).catch(()=>null);
        onActivity(['playing','locating','settling','advancing','quizWait','awaitingConfirm'].includes(ready.state));
        state.phase=['playing','locating','settling','advancing','quizWait','awaitingConfirm'].includes(ready.state)?'running':'ready'; state.error='';
        if (pendingStart) {
          const selectedAtStart=selected;
          const started=await studyFrame.executeJavaScript('Promise.resolve(window.__cxNaturalWatchApp.runner.start()).then(()=>true)',true).catch(()=>false);
          // Navigation can detach the frame between readiness and execution.
          // Keep the request pending until the actual call succeeds.
          if(started&&selected===selectedAtStart){pendingStart=false;state.phase='running';}
        }
      } else if (selected) {
        onActivity(false);
        state.phase='opening';
        let catalogFrame=null,catalog=null;
        for(const frame of all){const value=await frame.executeJavaScript(catalogCode(),true).catch(()=>null);if(value?.ok){catalog=value;catalogFrame=frame;break;}}
        if(catalog){await catalogFrame.executeJavaScript(refreshCatalogCode(),true).catch(()=>null);state.phase='chapters';state.error='';if(!pendingStart)return;}
        if(Date.now()-openingSince>25000){state.phase='manual';state.error='未能打开章节，可在主界面重试或显示网页查看';}
        if(catalog&&pendingStart){
          const key=catalogFrame.url,attempt=attempted.get(key);
          if(attempt&&Date.now()-attempt.at<4000)return;
          if(attempt?.count>=3){state.phase='manual';state.error='章节打开失败，可重新选择章节重试';return;}
          const result=await catalogFrame.executeJavaScript(catalogCode({strategy:getStrategy()}),true).catch(()=>({ok:false}));
          if(result.reason==='no-pending-chapter'){pendingStart=false;state.phase='complete';return;}
          attempted.set(key,{at:Date.now(),count:(attempt?.count||0)+1});return;
        }
        for (const frame of all) {
          const key=frame.url;
          const attempt=attempted.get(key);
          if(attempt&&(Date.now()-attempt.at<4000||attempt.count>=3))continue;
          if(await read(frame,enterStudyPage).catch(()=>false)) { attempted.set(key,{at:Date.now(),count:(attempt?.count||0)+1}); break; }
        }
      } else state.phase=courses.size?'catalog':'login';
    } catch { state.error='后台读取暂时失败，可重新读取或显示原网页处理'; }
    finally { busy=false; }
  }
  const timer=setInterval(tick,interval); timer.unref?.();
  return {
    async list() { await tick(); return {ok:true,courses:[...courses.values()].map(({id,name,cover})=>({id,name,cover})),state:{...state},profile:{...profile}}; },
    status() { return {...state,pendingStart,...(browser.info?.().error?{error:browser.info().error}:{})}; },
    async overview() {
      for(const frame of frames()){try{const data=await frame.executeJavaScript(catalogCode(),true);if(data?.ok)return data;}catch{}}
      return {ok:false,reason:'no-catalog'};
    },
    async refreshProgress(){
      for(const frame of frames()){
        const runner=await frame.executeJavaScript('window.__cxNaturalWatchApp?.runner?.refreshProgress?.(true)').catch(()=>null);
        if(runner)return runner;
        const catalog=await frame.executeJavaScript(catalogCode()).catch(()=>null);
        if(catalog?.ok)return frame.executeJavaScript(refreshCatalogCode(true)).catch(()=>({ok:false}));
      }
      return {ok:false,reason:'no-catalog'};
    },
    async openChapter(chapter) {
      if(!selected)return {ok:false,error:'先选择课程'};
      if(!chapter||typeof chapter.key!=='string'||typeof chapter.title!=='string')return {ok:false,error:'章节参数无效'};
      for(const frame of frames()){
        const result=await frame.executeJavaScript(catalogCode({key:chapter.key,title:chapter.title}),true).catch(()=>null);
        if(result?.ok){attempted.clear();openingSince=Date.now();state.phase='opening';state.error='';return {ok:true};}
      }
      return {ok:false,error:'章节列表已变化，请重新读取后再试'};
    },
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
    close() {stopped=true;pendingStart=false;onActivity(false);clearInterval(timer);courses.clear();state.verification=null;},
    tick,
  };
}
module.exports={createCoursePortal,readCourseLinks,readChallenge};
