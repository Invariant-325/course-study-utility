// One DOM reader for the landing catalog, learning catalog and desktop overview.
// Only explicit platform labels/counts are completion evidence.
function readChapterProgress(node) {
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
 const content=norm(node?.textContent);
 const marked=[node,...(node?.querySelectorAll('[title],[aria-label],[data-pending],[data-unfinished],.catalog_points,.chapter_points,.chapter-status,.catalog_state,.chapter-state,.icon_Completed,.catalog_points_done,.catalog_finish,.chapter-complete,.icon-complete,.icon_completed')||[])];
 const hints=marked.flatMap(e=>[e.getAttribute?.('aria-label'),e.getAttribute?.('title')]).filter(Boolean).map(norm);
 const values=[...hints,content];let pending=null,total=null,completed=null;
 for(const e of marked)for(const attr of ['data-pending','data-unfinished']){const value=e.getAttribute?.(attr);if(value!==null&&value!==undefined&&/^\d+$/.test(value))pending=Number(value);}
 for(const value of values){
  const count=value.match(/(\d+)\s*个\s*(?:待完成|未完成)(?:任务点)?|(?:待完成|未完成)(?:任务点)?\s*[:：]\s*(\d+)/);
  if(count&&pending===null)pending=Number(count[1]??count[2]);
  const ratio=value.match(/(?:已完成任务点|已完成|任务点)\s*[:：]?\s*(\d+)\s*[/／]\s*(\d+)/);
  if(ratio&&Number(ratio[1])<=Number(ratio[2])){completed=Number(ratio[1]);total=Number(ratio[2]);if(pending===null)pending=total-completed;}
 }
 const statuses=[...(node?.querySelectorAll('.catalog_points,.chapter_points,.chapter-status,.catalog_state,.chapter-state,[data-pending],[aria-label],[title]')||[])];
 if(pending===null){const numeric=statuses.find(e=>e.matches('.catalog_points,.chapter_points')&&/^\d+$/.test(norm(e.textContent)));if(numeric)pending=Number(norm(numeric.textContent));}
 const completeMarker=marked.some(e=>e.matches?.('.icon_Completed,.catalog_points_done,.catalog_finish,.chapter-complete,.icon-complete,.icon_completed'))||[...hints,...statuses.map(e=>norm(e.textContent))].some(s=>/^(?:已完成(?:任务点)?|全部完成|任务点已完成)$/.test(s));
 if(completeMarker&&pending===null)pending=0;
 const kindDone=kind=>{for(const value of values){const m=value.match(kind==='video'?/(?:课程视频|视频)(?:任务)?\s*[:：]?\s*(未完成|待完成|已完成)/:/(?:章节测验|章节习题|习题|测验)(?:任务)?\s*[:：]?\s*(未完成|待完成|已完成)/);if(m)return m[1]==='已完成';}return null;};
 let videoDone=kindDone('video'),quizDone=kindDone('quiz');
 if(pending===null&&videoDone!==null&&quizDone!==null)pending=Number(!videoDone)+Number(!quizDone);
 return {pending,total,completed,complete:pending===0?true:pending>0?false:null,videoDone,quizDone};
}
if(typeof module!=='undefined'&&module.exports)module.exports={readChapterProgress,readPlatformHtml,catalogRequestUrl};

// Reuse the platform's own observed directory request, including its original parameters.
function catalogRequestUrl(){
 const valid=value=>{try{const u=new URL(value,location.href);return u.protocol==='https:'&&/(^|\.)(chaoxing|xuexitong)\.com$/i.test(u.hostname)&&/\/mycourse\/studentstudycourselist$/.test(u.pathname)}catch{return false}};
 const resources=window.performance?.getEntriesByType?.('resource')||[];
 const entry=[...resources].reverse().find(e=>valid(e.name));
 if(entry)window.__cxCatalogReadRequest={page:location.href,url:entry.name};
 const previous=window.__cxCatalogReadRequest;
 return previous?.page===location.href&&valid(previous.url)?previous.url:location.href;
}
async function readPlatformHtml(response){
 if(typeof response.arrayBuffer!=='function')return response.text();
 const bytes=await response.arrayBuffer();
 const header=response.headers?.get?.('content-type')||'';
 const prefix=new TextDecoder('utf-8').decode(bytes.slice(0,2048));
 const charset=/charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(header)?.[1]||/charset\s*=\s*["']?(gbk|gb2312|gb18030)/i.exec(prefix)?.[1]||'utf-8';
 return new TextDecoder(charset).decode(bytes);
}
