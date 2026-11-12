const {readChapterProgress,readPlatformHtml,catalogRequestUrl}=require('./catalog-progress.cjs');
const {cleanChapterTitle} = require('./chapter-title.cjs');

// Runs in each platform frame, including the course landing page before the
// userscript mounts. Click existing DOM controls; never synthesize signed URLs.
function inspectCatalog(clean, action = null, doc = document, readProgress = readChapterProgress) {
  const text = e => String(e?.textContent || '').replace(/\s+/g,' ').trim();
  const clickable = e => e.matches('a[href],[onclick],[role=button]') ? e : e.querySelector('a[href],[onclick],[role=button]');
  let nodes = [...doc.querySelectorAll('.posCatalog_select:not(.posCatalog_first),.chapter_item,.chapter-item,.chapter_unit,.chapter-unit,.catalog_item,.catalog-item')];
  nodes = nodes.filter(e => !nodes.some(other => other !== e && e.contains(other)));
  if (!nodes.length) {
    if(!/\/mycourse\/|\/course\//i.test(location.pathname))return {ok:false,reason:'not-course-page',items:[]};
    nodes = [...doc.querySelectorAll('a[href],[onclick],[role=button]')].filter(e => {
      const title = e.getAttribute('title') || text(e);
      return /^(?:\d+\s+)?\d+(?:[.．]\d+)+\s*\S/.test(title) && title.length < 240;
    });
    nodes = nodes.filter(e => !nodes.some(other => other !== e && e.contains(other)));
  }
  const rows = nodes.flatMap((node,index) => {
    const target=clickable(node);
    if (!target || node.matches('.posCatalog_first,.firstLayer,.chapter-heading,.chapter_head')) return [];
    const label=node.querySelector('.chapter-title,.catalog_name,.catalog_title,.posCatalog_name,.chapter_name,.chapter-name,[title]');
    let title = text(label) || label?.getAttribute('title') || target.getAttribute('title') || text(node);
    title=clean(title.replace(/^\d+\s+(?=\d+[.．]\d+)/,''));
    if (!title) return [];
    const progress=readProgress(node),pending=progress.pending,done=progress.complete===true;
    const locked=target.getAttribute('aria-disabled')==='true'||node.matches('.locked,.disabled')||!!node.querySelector('.icon-lock,.chapter-lock');
    return [{node,target,index,title,...progress,locked}];
  });
  const fresh=window.__cxLandingProgress;
  if(doc===document&&fresh?.url===location.href&&Date.now()-fresh.at<45000){for(const row of rows){const item=fresh.data.items.find(i=>i.title===row.title);if(item&&row.pending!==0&&fresh.baseline?.[row.title]===JSON.stringify(readProgress(row.node))){Object.assign(row,{...item,node:row.node,target:row.target,index:row.index});}}}
  if (action) {
    const row=action.title ? rows.find(r=>(!action.key||action.key.startsWith('tree-')||'chapter-'+r.index===action.key)&&r.title===action.title) : action.strategy==='auto'?rows.find(r=>!r.locked&&r.complete!==true):rows.find(r=>!r.locked&&r.pending>0)||rows.find(r=>!r.locked&&r.complete!==true);
    if (!row || row.locked) return {ok:false,reason:rows.length?'no-pending-chapter':'no-catalog'};
    const href=row.target.getAttribute('href')||'';
    if (/^(?:https?:|\/)/i.test(href)) {
      let url;try{url=new URL(href,location.href)}catch{return {ok:false,reason:'invalid-link'}}
      if(!/^https?:$/.test(url.protocol)||!/(^|\.)(chaoxing|xuexitong)\.com$/i.test(url.hostname))return {ok:false,reason:'blocked-link'};
    } else if(href && !/^(?:#|javascript:)/i.test(href)) return {ok:false,reason:'blocked-link'};
    row.target.click();return {ok:true};
  }
  const walker=doc.createTreeWalker(doc.body,4),parts=[];while(walker.nextNode())parts.push(walker.currentNode.nodeValue);
  const body=String(doc===document&&doc.body?.innerText?doc.body.innerText:parts.join(' '));
  const sum=body.match(/已完成任务点\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/);
  const summary=doc===document&&fresh?.url===location.href&&Date.now()-fresh.at<45000&&fresh.data.summary?fresh.data.summary:sum&&Number(sum[1])<=Number(sum[2])?{done:Number(sum[1]),total:Number(sum[2])}:null;
  return {ok:rows.length>0,source:'course-page',items:rows.map(({node,target,index,...item})=>({key:'chapter-'+index,...item})),summary,
    progress:{items:rows.map(r=>({title:r.title,text:r.title,pending:r.pending,active:r.node.matches('.posCatalog_active,.active')}))},jobs:[],cursor:null};
}
function catalogCode(action) {return '('+inspectCatalog.toString()+')('+cleanChapterTitle.toString()+','+JSON.stringify(action||null)+',document,'+readChapterProgress.toString()+')';}
function refreshCatalogCode(force=false){return `(async()=>{const previous=window.__cxLandingProgress;if(!${!!force}&&previous?.url===location.href&&Date.now()-previous.at<30000)return {ok:true,cached:true};const url=location.href;const baseline=Object.fromEntries([...document.querySelectorAll('.posCatalog_select,.chapter_item,.chapter-item,.catalog_item,.catalog-item')].map(e=>{const label=e.querySelector('.catalog_name,.posCatalog_name,.chapter-title,[title]');return [(${cleanChapterTitle.toString()})(label?.getAttribute('title')||label?.textContent||e.textContent),JSON.stringify((${readChapterProgress.toString()})(e))]}));try{const res=await fetch((${catalogRequestUrl.toString()})(),{credentials:'include',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(6000)});if(!res.ok||location.href!==url)return{ok:false};const doc=new DOMParser().parseFromString(await (${readPlatformHtml.toString()})(res),'text/html');const data=(${inspectCatalog.toString()})(${cleanChapterTitle.toString()},null,doc,${readChapterProgress.toString()});if(!data.ok||location.href!==url)return{ok:false};window.__cxLandingProgress={url,at:Date.now(),data,baseline};return{ok:true};}catch{return{ok:false};}})()`;}
module.exports={inspectCatalog,catalogCode,refreshCatalogCode};
