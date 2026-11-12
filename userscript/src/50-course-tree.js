// ---------------------------------------------------------------------------
// course-tree.js —— 任务点枚举、完成态判定、目标选择、章节推进
//
// 真实页面证据（2026-11-10 实测 mooc1/mycourse/studentstudy）：
//   任务点容器 = .ans-attach-ct（附加类 .videoContainer），**不是** .ans-job（不存在）
//   完成图标   = .ans-job-icon[aria-label="任务点未完成"]（与旧版一致）
//   播放器     = video#video_html5_api.vjs-tech（在第二层 iframe 内）
//   目录       = #coursetree / .posCatalog_level / .posCatalog_select / .posCatalog_active
//   目录完成度 = 每节文本含 "N个待完成任务点"
//
// 完成态只信平台渲染的信号，不用本地记账认定"已完成"。
// ---------------------------------------------------------------------------
const CourseTree = (function () {
  let freshCatalog={url:'',at:0,counts:new Map(),summary:null},refreshing=null,lastAttempt={url:'',at:0};
  const visitedCatalog=new Set();
  function chapterName(el){return Dom.textOf(queryFirst(el,SEL.catalogNameNode)||el,160).replace(/\s*\d+\s*个待完成(?:任务点)?\s*$/,'').trim();}
  function resetTraversal(){visitedCatalog.clear();}
  async function refreshCatalog(force){
    if(typeof window.fetch!=='function'||typeof window.DOMParser!=='function')return {ok:false,reason:'unavailable'};
    if(refreshing)return refreshing;
    if(!force&&freshCatalog.url===location.href&&Date.now()-freshCatalog.at<30000)return {ok:true,cached:true};
    const url=location.href,baseline=new Map(catalogEntries().items.map(el=>[chapterName(el),JSON.stringify(readChapterProgress(el))]));
    if(!force&&lastAttempt.url===url&&Date.now()-lastAttempt.at<30000)return {ok:false,reason:'cooldown'};
    lastAttempt={url,at:Date.now()};
    refreshing=(async()=>{const controller=new window.AbortController();const timer=setTimeout(()=>controller.abort(),6000);
      try{
        const response=await window.fetch(catalogRequestUrl(),{credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal});
        if(!response.ok||location.href!==url)return {ok:false,reason:'navigation-or-network'};
        const doc=new window.DOMParser().parseFromString(await readPlatformHtml(response),'text/html');
        const nodes=[...doc.querySelectorAll('.posCatalog_select')].filter(el=>!el.classList.contains(SEL.firstLayerClass));
        if(!nodes.length)return {ok:false,reason:'no-fresh-catalog'};
        const counts=new Map();
        for(const el of nodes){const value=readChapterProgress(el);if(value.pending!==null)counts.set(chapterName(el),value.pending);}
        if(location.href!==url)return {ok:false,reason:'navigation'};
        const walker=doc.createTreeWalker(doc.body,4),parts=[];while(walker.nextNode())parts.push(walker.currentNode.nodeValue);
        const sum=parts.join(' ').match(/已完成任务点\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/);
        freshCatalog={url,at:Date.now(),counts,baseline,summary:sum&&Number(sum[1])<=Number(sum[2])?{done:Number(sum[1]),total:Number(sum[2])}:null};
        return {ok:true,known:counts.size};
      }catch{return {ok:false,reason:'refresh-failed'}}finally{clearTimeout(timer);refreshing=null;}
    })();return refreshing;
  }
  function currentCatalogComplete(){const active=catalogEntries().items.find(isActiveItem);return !!active&&readCatalogPending(active)===0;}
  function selectFirstIncomplete(){
    const items=catalogEntries().items;if(!items.length)return {ok:true,changed:false};
    const first=items.find(el=>readCatalogPending(el)!==0);if(!first)return {ok:true,changed:false};
    // Unknown entries are inspected by opening their actual chapter; never mark them complete.
    if(isActiveItem(first))return {ok:true,changed:false};
    const before=signatureOf(enumerate());
    return {ok:Dom.click(queryFirst(first,SEL.catalogNameNode)||first),changed:true,before};
  }
  // ---------- 完成态（自身 + 向上有限查找）----------
  function readStateOnNode(el) {
    try {
      if (el.classList && el.classList.contains(SEL.jobFinishedClass)) {
        return { state: 'finished', by: 'class' };
      }
    } catch (e) {
      /* ignore */
    }

    const icon = queryFirst(el, SEL.jobIcon);
    if (!icon) return { state: 'unknown', by: 'none' };

    let label = '';
    let title = '';
    try {
      label = (icon.getAttribute('aria-label') || '').trim();
      title = (icon.getAttribute('title') || '').trim();
    } catch (e) {
      /* ignore */
    }
    const haystack = label + ' ' + title;
    for (const token of SEL.iconLabelUnfinished) {
      if (haystack.indexOf(token) !== -1) {
        return { state: 'unfinished', by: 'label', label: label || title };
      }
    }
    for (const token of SEL.iconLabelFinished) {
      if (haystack.indexOf(token) !== -1) {
        return { state: 'finished', by: 'label', label: label || title };
      }
    }
    return { state: 'unknown', by: 'label-unknown', label: label || title };
  }

  // 容器被去重后可能是内层元素，完成标记可能挂在外层；
  // 向上最多 3 层查找，但祖先若包含多个任务点图标则停止，避免串台。
  function readJobState(container) {
    let node = container;
    for (let depth = 0; depth < 3 && node; depth++) {
      const state = readStateOnNode(node);
      if (state.state !== 'unknown') return state;
      const parent = node.parentElement;
      if (!parent) break;
      try {
        if (parent.querySelectorAll('.ans-job-icon').length > 1) break;
      } catch (e) {
        break;
      }
      node = parent;
    }
    return { state: 'unknown', by: 'none' };
  }

  // ---------- 容器收集 ----------
  function Doc_icons(doc) {
    try {
      return Dom.toArray(doc.querySelectorAll('.ans-job-icon'));
    } catch (e) {
      return [];
    }
  }

  function closestAny(el, selectors) {
    if (!el || !el.closest) return null;
    for (const selector of selectors) {
      try {
        const found = el.closest(selector);
        if (found) return found;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  function isJobContainer(el) {
    if (!el || !el.querySelectorAll) return false;
    try {
      if (el.querySelector('.ans-job-icon')) return true;
      return el.querySelectorAll('iframe').length > 0;
    } catch (e) {
      return false;
    }
  }

  // 不同版本选择器可能同时命中嵌套元素：只保留最内层，避免一个任务点被统计两次。
  function dropOuterContainers(containers) {
    if (containers.length < 2) return containers;
    return containers.filter(function (el) {
      for (const other of containers) {
        if (other === el) continue;
        try {
          if (el.contains(other)) return false;
        } catch (e) {
          /* ignore */
        }
      }
      return true;
    });
  }

  function collectJobContainers(doc) {
    const seen = new Set();
    const raw = [];

    for (const el of queryAllAcross(doc, SEL.jobContainer)) {
      if (!seen.has(el)) {
        seen.add(el);
        raw.push(el);
      }
    }
    if (!raw.length) {
      for (const icon of Doc_icons(doc)) {
        const parent = closestAny(icon, SEL.jobContainer) || icon.parentElement;
        if (parent && !seen.has(parent)) {
          seen.add(parent);
          raw.push(parent);
        }
      }
    }
    return dropOuterContainers(raw.filter(isJobContainer));
  }

  // ---------- 类型 ----------
  function detectJobType(frames) {
    for (const frame of frames) {
      const url = Dom.frameUrl(frame);
      if (!url) continue;
      for (const pattern of SEL.jobTypePatterns) {
        if (pattern.re.test(url)) return pattern.type;
      }
    }
    for (const frame of frames) {
      const data = Dom.parseFrameData(frame);
      if (!data) continue;
      const raw = String(data.type || data.jobType || data.jobTypeName || '').toLowerCase();
      if (!raw) continue;
      if (/video/.test(raw)) return 'video';
      if (/audio/.test(raw)) return 'audio';
      if (/work|test|quiz|exam/.test(raw)) return 'work';
      if (/doc|pdf|ppt|image|img/.test(raw)) return 'document';
      return raw;
    }
    return 'unknown';
  }

  // ---------- 任务点描述 ----------
  function describeJob(job) {
    if (!job) return '';
    const data = Dom.parseFrameData(job.frameEl);
    if (data) {
      const title = data.title || data.name || data.jobName || data.objectidName;
      if (title) return String(title).slice(0, 80);
    }
    try {
      const titled = job.container.querySelector('[title]');
      if (titled) {
        const title = titled.getAttribute('title');
        if (title) return String(title).slice(0, 80);
      }
    } catch (e) {
      /* ignore */
    }
    const text = Dom.textOf(job.container, 60);
    return text || '任务点 ' + job.id;
  }

  // ---------- 枚举 ----------
  function enumerateDetail() {
    const collected = Dom.collectDocuments(window, SEL.maxFrameDepth);
    const docs = collected.documents || [];
    const jobs = [];

    for (let docIndex = 0; docIndex < docs.length; docIndex++) {
      const entry = docs[docIndex];
      const containers = collectJobContainers(entry.doc);
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i];
        const stateInfo = readJobState(container);
        const frames = Dom.toArray(container.querySelectorAll('iframe'));
        const job = {
          id: 'd' + docIndex + '#' + i,
          docIndex: docIndex,
          indexInDoc: i,
          depth: entry.depth,
          doc: entry.doc,
          container: container,
          frames: frames,
          frameEl: frames[0] || null,
          state: currentCatalogComplete()?'finished':stateInfo.state,
          stateBy: stateInfo.by,
          stateLabel: stateInfo.label || '',
          type: detectJobType(frames),
        };
        job.title = describeJob(job);
        job.stableKey = CourseUrl.jobKey(job);
        jobs.push(job);
      }
    }

    return {
      jobs: jobs,
      inaccessible: collected.inaccessible || [],
      documents: docs,
      stats: {
        documentCount: docs.length,
        jobCount: jobs.length,
        unfinished: jobs.filter((j) => j.state === 'unfinished').length,
        finished: jobs.filter((j) => j.state === 'finished').length,
        unknown: jobs.filter((j) => j.state === 'unknown').length,
      },
    };
  }

  function enumerate() {
    return enumerateDetail().jobs;
  }

  function signatureOf(jobs) {
    return jobs.map((j) => j.id + ':' + j.state + ':' + j.type).join('|');
  }

  // ---------- 视频定位 ----------
  function deepFindVideo(frame, depth) {
    if (!frame || depth > 2) return null;
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch (e) {
      return null;
    }
    if (!doc) return null;
    const direct = queryFirst(doc, SEL.videoElement);
    if (direct) return direct;
    for (const child of Dom.toArray(doc.querySelectorAll('iframe'))) {
      const nested = deepFindVideo(child, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function findVideoInJob(job) {
    if (!job || !job.container) return null;
    const direct = queryFirst(job.container, SEL.videoElement);
    if (direct) return direct;
    for (const frame of job.frames) {
      const found = deepFindVideo(frame, 0);
      if (found) return found;
    }
    return null;
  }

  // ---------- 目标选择 ----------
  // 从 currentId 之后找第一个"平台标记未完成且能拿到 video"的任务点。
  // excludeKeys: 已跳过待确认(awaitingConfirm 后用户选择跳过)的任务，必须排除，
  // 否则会在下一轮被重新选中造成重复播放。
  function pickNextVideoTarget(jobs, currentId, options) {
    const excludeKeys = (options && options.excludeKeys) || null;
    let passed = !currentId;
    const skipped = [];

    for (const job of jobs) {
      if (!passed) {
        if (job.id === currentId) passed = true;
        continue;
      }
      if (job.state === 'finished') continue;
      if (excludeKeys && job.stableKey && excludeKeys.has(job.stableKey)) {
        skipped.push(job);
        continue;
      }
      if (job.state === 'unknown') {
        skipped.push(job);
        continue;
      }
      if (job.type === 'video' || job.type === 'unknown') {
        if (job.type === 'unknown') {
          if (!findVideoInJob(job)) {
            skipped.push(job);
            continue;
          }
        }
        return { job: job, skipped: skipped };
      }
      skipped.push(job);
    }
    return { job: null, skipped: skipped };
  }

  // ---------- 章节测验（work 类任务点）----------
  // 连播流程只处理 video；这里把"未完成的 work"单独挑出来，
  // 供 Runner 在切下一节之前先把本节测验做掉。
  function findPendingWorkJobs(jobs) {
    return (jobs || []).filter(function (job) {
      return job && job.type === 'work' && job.state !== 'finished';
    });
  }

  // 尝试打开某个 work 任务点。
  // 学习通的任务点结构没有稳定统一的入口，这里按可靠性从高到低尝试，
  // 全部失败就返回 ok:false，由调用方降级为人工处理（绝不盲点）。
  function openWorkJob(job) {
    if (!job || !job.container) return { ok: false, reason: 'no-container' };
    const container = job.container;

    let links = [];
    try {
      links = Dom.toArray(container.querySelectorAll('a[href]'));
    } catch (e) {
      links = [];
    }
    for (const a of links) {
      let href = '';
      try {
        href = String(a.getAttribute('href') || '');
      } catch (e) {
        continue;
      }
      if (/workId=|doHomeWorkNew|work\/doWork/i.test(href)) {
        if (Dom.click(a)) return { ok: true, by: 'link', href: href.slice(0, 160) };
      }
    }

    let onclickEls = [];
    try {
      onclickEls = Dom.toArray(container.querySelectorAll('[onclick]'));
    } catch (e) {
      onclickEls = [];
    }
    for (const el of onclickEls) {
      let oc = '';
      try {
        oc = String(el.getAttribute('onclick') || '');
      } catch (e) {
        continue;
      }
      if (/work|homework|quiz|ti|exam/i.test(oc)) {
        if (Dom.click(el)) return { ok: true, by: 'onclick', onclick: oc.slice(0, 80) };
      }
    }

    // 兜底：点任务点图标/容器本身（多数情况只是切换右侧内容，不会误提交）
    let icon = null;
    try {
      icon = container.querySelector(SEL.jobIcon);
    } catch (e) {
      icon = null;
    }
    if (icon && Dom.click(icon)) return { ok: true, by: 'icon' };
    if (Dom.click(container)) return { ok: true, by: 'container' };

    return { ok: false, reason: 'no-handle' };
  }

  // ---------- 目录 ----------
  function catalogEntries() {
    const topDoc = window.document;
    for (const rootSelector of SEL.catalogRoot) {
      let root = null;
      try {
        root = topDoc.querySelector(rootSelector);
      } catch (e) {
        continue;
      }
      if (!root) continue;

      const all = queryAllFirst(root, SEL.catalogItem);
      if (!all.length) continue;

      const leaf = all.filter((el) => {
        try {
          return !(el.classList && el.classList.contains(SEL.firstLayerClass));
        } catch (e) {
          return true;
        }
      });
      const items = leaf.length ? leaf : all;
      return { root: root, items: items, all: all, rootSelector: rootSelector };
    }
    return { root: null, items: [], all: [], rootSelector: null };
  }

  // ---------- 目录层完成度 ----------
  function readCatalogPending(itemEl) {
    if (!itemEl) return null;
    const live=readChapterProgress(itemEl),name=chapterName(itemEl);
    // A later DOM mutation is newer than a fetched snapshot. Zero on screen always wins.
    if(live.pending===0)return 0;
    if(freshCatalog.url===location.href&&Date.now()-freshCatalog.at<45000&&freshCatalog.counts.has(name)&&freshCatalog.baseline?.get(name)===JSON.stringify(live))return freshCatalog.counts.get(name);
    return live.pending;
  }
  function readCatalogState(itemEl){const live=readChapterProgress(itemEl),pending=readCatalogPending(itemEl);return {...live,pending,complete:pending===0?true:pending>0?false:null};}

  function isFirstLayer(el) {
    try {
      return !!(el.classList && el.classList.contains(SEL.firstLayerClass));
    } catch (e) {
      return false;
    }
  }

  function isActiveItem(el) {
    try {
      return (
        (el.classList && el.classList.contains(SEL.catalogActiveClass)) ||
        !!el.querySelector('.' + SEL.catalogActiveClass)
      );
    } catch (e) {
      return false;
    }
  }

  // 汇总目录层进度。
  // 章级(firstLayer) 与叶子节点分开统计，未知计数单独记录，避免重复统计与误判完成。
  function catalogProgress() {
    const catalog = catalogEntries();
    const leafItems = [];
    let firstLayerCount = 0;

    for (const el of catalog.all || catalog.items) {
      if (isFirstLayer(el)) {
        firstLayerCount++;
        continue;
      }
      leafItems.push({
        title:chapterName(el),
        text: Dom.textOf(el, 48),
        pending: readCatalogPending(el),
        active: isActiveItem(el),
      });
    }

    let pending = 0;
    let unknown = 0;
    for (const item of leafItems) {
      if (item.pending === null) unknown++;
      else pending += item.pending;
    }

    return {
      ok: leafItems.length > 0,
      rootSelector: catalog.rootSelector,
      total: leafItems.length,
      firstLayerCount: firstLayerCount,
      pending: pending,
      unknown: unknown,
      items: leafItems,
    };
  }

  // 头部汇总，形如 "已完成任务点: 0/59"
  // 实机验证发现：.chapter_head 位于内层 iframe（knowledge/cards），不在顶层文档，
  // 因此必须遍历全部可达文档，不能只看 window.document。
  function readCatalogSummary() {
    if(freshCatalog.url===location.href&&Date.now()-freshCatalog.at<45000&&freshCatalog.summary)return {...freshCatalog.summary};
    let docs = [];
    try {
      const collected = Dom.collectDocuments(window, SEL.maxFrameDepth);
      docs = (collected && collected.documents) || [];
    } catch (e) {
      docs = [];
    }
    docs = docs.concat([{ doc: window.document }]);

    for (const entry of docs) {
      const doc = entry.doc;
      if (!doc) continue;
      for (const selector of ['.chapter_head', '#catalogHead']) {
        let el = null;
        try {
          el = doc.querySelector(selector);
        } catch (e) {
          continue;
        }
        if (!el) continue;
        const match = Dom.textOf(el, 3000).match(SEL.catalogSummaryText);
        if (match) return { done: Number(match[1]), total: Number(match[2]) };
      }
    }
    return null;
  }

  function readTaskTabs() {
    const topDoc = window.document;
    let nodes = [];
    try {
      nodes = Dom.toArray(topDoc.querySelectorAll(SEL.taskTabSelector));
    } catch (e) {
      nodes = [];
    }
    const result = { video: false, quiz: false, labels: [] };
    for (const node of nodes) {
      const text = Dom.textOf(node, 24).replace(/\s+/g, '');
      if (!text) continue;
      if (SEL.taskTabVideo.test(text)) result.video = true;
      if (SEL.taskTabQuiz.test(text)) result.quiz = true;
      if (result.labels.length < 8) result.labels.push(text);
    }
    return result;
  }

  function clickNextCatalogItem() {
    const catalog = catalogEntries();
    if (!catalog.items.length) return { ok: false, reason: 'no-catalog' };

    let activeIndex = -1;
    for (let i = 0; i < catalog.items.length; i++) {
      if (isActiveItem(catalog.items[i])) {
        activeIndex = i;
        break;
      }
    }
    if (activeIndex < 0) return { ok: false, reason: 'no-active-item' };

    visitedCatalog.add(chapterName(catalog.items[activeIndex]));
    const strategy=typeof Config==='undefined'?'sequential':Config.get('studyStrategy');
    const order=strategy==='auto'||strategy==='quiz-first'||strategy==='quiz-only'
      ? catalog.items.map((_,i)=>i) : [...catalog.items.keys()].slice(activeIndex+1).concat([...catalog.items.keys()].slice(0,activeIndex));
    const nextIndex=order.find(i=>i!==activeIndex&&!visitedCatalog.has(chapterName(catalog.items[i]))&&readCatalogPending(catalog.items[i])>0);
    const next=nextIndex===undefined?null:catalog.items[nextIndex];
    if(!next)return {ok:false,reason:catalog.items.some(el=>readCatalogPending(el)===null&&!visitedCatalog.has(chapterName(el)))?'unverified-catalog':'all-complete'};

    const target = queryFirst(next, SEL.catalogNameNode) || next;
    const title = Dom.textOf(next, 40);
    if (!Dom.click(target)) return { ok: false, reason: 'click-failed' };
    return { ok: true, by: 'catalog:' + catalog.rootSelector, title: title, index: nextIndex };
  }

  function clickNextSectionButton() {
    const topDoc = window.document;
    for (const popSelector of SEL.popContainer) {
      let pop = null;
      try {
        pop = topDoc.querySelector(popSelector);
      } catch (e) {
        continue;
      }
      if (!pop) continue;
      const visible = pop.style ? pop.style.display !== 'none' : true;
      if (!visible) continue;
      const btn = pop.querySelector('.nextChapter') || pop.querySelector('[class*="next"]');
      if (btn) {
        Dom.click(btn);
        return { ok: true, by: 'popup-next' };
      }
    }

    for (const selector of SEL.nextSectionButton) {
      let el = null;
      try {
        el = topDoc.querySelector(selector);
      } catch (e) {
        continue;
      }
      if (el && Dom.isVisible(el)) {
        Dom.click(el);
        return { ok: true, by: selector };
      }
    }
    return { ok: false, reason: 'no-next-button' };
  }

  async function waitForJobsChange(previousSignature, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await Dom.waitTimeout(700);
      const jobs = enumerate();
      const signature = signatureOf(jobs);
      if (signature !== previousSignature) {
        return { changed: true, jobs: jobs, signature: signature };
      }
    }
    const jobs = enumerate();
    return { changed: false, jobs: jobs, signature: signatureOf(jobs) };
  }

  return {
    activeCatalogKey(){const active=catalogEntries().items.find(isActiveItem);return active?chapterName(active):'';},
    refreshCatalog,resetTraversal,currentCatalogComplete,selectFirstIncomplete,
    enumerate,
    enumerateDetail,
    signatureOf,
    readJobState,
    detectJobType,
    describeJob,
    findVideoInJob,
    pickNextVideoTarget,
    findPendingWorkJobs,
    openWorkJob,
    catalogEntries,
    catalogProgress,
    readCatalogPending,readCatalogState,
    readCatalogSummary,
    readTaskTabs,
    clickNextCatalogItem,
    clickNextSectionButton,
    waitForJobsChange,
  };
})();
