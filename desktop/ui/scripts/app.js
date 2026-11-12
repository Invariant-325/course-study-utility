/* ===========================================================================
   app.js —— 原型交互（纯前端模拟数据，不连接真实 Electron）
   =========================================================================== */

(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // preload 暴露的是 window.__cxApp；浏览器里直接开预览时没有它
  const App = window.__cxApp || null;
  const IS_PREVIEW = !App || typeof App.courseOverview !== 'function';

  // ---------------- 运行时数据（由真实 IPC 填充） ----------------
  let COURSES = [];
  let selectedCourse = '';
  let PROFILE={name:'',avatar:''};
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let CHAPTERS = [];
  let QUEUE = [];
  let ISSUES = [];
  let LOGS = [];
  let TODAY = { playSeconds: 0, visionCalls: 0, visionFail: 0, promptTokens: 0, completionTokens: 0, tasksConfirmed: 0 };
  let RUNNER = { mounted: false, snap: {} };
  let MODEL = { hasKey: false, keySource: '', keyMasked: '' };

  // ---------------- 预览用假数据（仅在浏览器直开时使用） ----------------
  const PREVIEW_COURSES = [
    {
      id: 'c1',
      name: '形势与政策（2026年秋）',
      teacher: '张明',
      total: 59,
      done: 24,
      state: 'doing',
      current: '1.2 习近平党建思想的核心要义',
    },
    {
      id: 'c2',
      name: '马克思主义基本原理',
      teacher: '李红',
      total: 42,
      done: 42,
      state: 'done',
      current: '全部完成',
    },
    {
      id: 'c3',
      name: '中国近现代史纲要',
      teacher: '王建国',
      total: 38,
      done: 5,
      state: 'manual',
      current: '3.1 需要扫码验证',
    },
    {
      id: 'c4',
      name: '思想道德与法治',
      teacher: '陈静',
      total: 46,
      done: 0,
      state: 'todo',
      current: '尚未开始',
    },
  ];

  const PREVIEW_CHAPTERS = [
    { name: '1.1 大党之治：百年党史中最恢弘的篇章', state: 'done', pending: 0 },
    { name: '1.2 习近平党建思想的核心要义', state: 'doing', pending: 2, current: true },
    { name: '1.3 深刻认识习近平党建思想的原创性贡献', state: 'todo', pending: 2 },
    { name: '1.4 青年学子在兴党强国中的使命担当', state: 'todo', pending: 2 },
    { name: '2.1 制定和实施五年规划是中国式现代化的重要保障', state: 'todo', pending: 2 },
    { name: '2.2 "十五五"时期在基本实现现代化进程中的历史方位', state: 'todo', pending: 2 },
    { name: '2.3 深刻领会"十五五"时期经济社会发展的指导方针', state: 'todo', pending: 2 },
    { name: '2.4 青年要在推进中国式现代化中挺膺担当', state: 'todo', pending: 2 },
    { name: '3.1 习近平经济思想对发展实体经济的指导意义', state: 'todo', pending: 2 },
    { name: '3.2 发展实体经济是建设现代化产业体系的着力点', state: 'todo', pending: 2 },
  ];

  const PREVIEW_QUEUE = [
    { name: '1.2 习近平党建思想的核心要义', sub: '视频 · 高优先级', state: 'doing' },
    { name: '1.2 章节测验', sub: '测验 · 高优先级', state: 'todo' },
    { name: '1.3 深刻认识习近平党建思想…', sub: '视频 · 中优先级', state: 'todo' },
  ];

  const PREVIEW_ISSUES = [
    { kind: 'warn', title: '本节有 1 个测验待提交', fix: '自动提交未开启。核对答案后手动提交，再点继续。' },
  ];

  const PREVIEW_LOGS = [
    ['09:42:11', 'ok', '课程状态：正在播放'],
    ['09:42:10', 'info', '平台确认 1.1 任务点完成（24/59）'],
    ['09:41:58', 'info', '切换下一节：1.2 习近平党建思想的核心要义'],
    ['09:41:57', 'info', '视频播放结束，等待平台确认'],
    ['09:34:02', 'info', '开始自动刷课'],
    ['09:33:59', 'ok', '模型连接正常 · 412ms · deepseek-chat'],
  ];

  const SEEDS = ['#4C6FFF', '#0F9D58', '#C2410C', '#7C3AED', '#0E7490', '#B91C1C'];

  // ---------------------------------------------------------------- 侧栏课程列表
function renderSideCourses() {
  const box = $('#sideCourses');
  if (!box) return;
  box.innerHTML = COURSES.map((c) => {
    const rel = c.total == null ? '未读取章节' : c.state === 'done' ? '已完成' : c.state === 'doing' ? '进行中' : c.state === 'manual' ? '需人工' : '未开始';
    return (
      '<button class="lnk" data-selected="'+(c.id===selectedCourse)+'" data-course="' + escapeHtml(c.id) + '" data-state="' + c.state + '">' +
        '<span class="dot"></span>' +
        '<span class="lt">' + escapeHtml(c.name) + '</span>' +
        '<span class="rt">' + rel + '</span>' +
      '</button>'
    );
  }).join('');

  $$('#sideCourses .lnk').forEach((el) => {
    el.addEventListener('click', () => {
      const c = COURSES.find((x) => x.id === el.dataset.course);
      if (!c) return;
      goto('workspace');
      snack('已切换到「' + c.name + '」');
    });
  });
}

// ---------------------------------------------------------------- 账户区
function renderAccount() {
 const name=$('#accName'),avatar=$('#accAvatar');
 if(name)name.textContent=PROFILE.name||'未读取账户';
 if(avatar){avatar.textContent=(PROFILE.name||'账户').slice(0,1);if(PROFILE.avatar){const img=document.createElement('img');img.src=PROFILE.avatar;img.alt='平台头像';img.onerror=()=>{avatar.textContent=(PROFILE.name||'账户').slice(0,1)};avatar.replaceChildren(img)}}
}

// 头像菜单
function bindAccount() {
  const user = $('#accUser');
  const menu = $('#userMenu');
  if (!user || !menu) return;

  function place() {
    const r = user.getBoundingClientRect();
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
    menu.style.top = 'auto';
  }

  function open() {
    place();
    menu.dataset.open = 'true';
  }

  function close() {
    menu.dataset.open = 'false';
  }

  user.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.dataset.open === 'true' ? close() : open();
  });

  document.addEventListener('click', (e) => {
    if (menu.dataset.open === 'true' && !menu.contains(e.target)) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    // Ctrl + ,
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      goto('settings');
      close();
    }
  });

  $$('#userMenu .mi').forEach((el) => {
    el.addEventListener('click', () => {
      const mi = el.dataset.mi;
      close();
      if (mi === 'settings') goto('settings');
      else if (mi === 'about') goto('about');
      else if (mi === 'logout')
        openDialog('退出登录', '退出后会清除本机保存的学习通登录状态，需要重新登录。确定？', () =>
          snack('退出登录尚未接入，请显示网页后在平台账户菜单退出')
        );
    });
  });

  // 预览用：?menu=1 自动打开头像菜单
  try {
    if (new URLSearchParams(location.search).get('menu') === '1') setTimeout(open, 200);
  } catch (e) {
    /* ignore */
  }
}

// ---------------- 页面切换 ----------------
  let currentPage = 'dashboard';

  function goto(page) {
    if (!page || page === currentPage) return;
    currentPage = page;
    if(['settings','about'].includes(page)&&$('#verificationPanel'))$('#verificationPanel').hidden=true;
    $$('.page').forEach((el) => {
      el.dataset.active = String(el.dataset.page === page);
    });
    $$('.sideitem[data-nav]').forEach((el) => {
      el.setAttribute('aria-selected', String(el.dataset.nav === page));
    });
    const main = $('#main');
    if (main) main.scrollTop = 0;
    updateFab();
  }

  // ---------------- 渲染：课程 ----------------
  function courseIcon() {
    return '<svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2.5h6.5A1.5 1.5 0 0 1 20 8v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/></svg>';
  }

  function stateChip(state) {
    if (state === 'selected') return '<span class="chip tone-primary">已选择</span>';
    if (state === 'unknown') return '<span class="chip">未读取章节</span>';
    if (state === 'done') return '<span class="chip tone-ok" style="height:26px"><span class="dot"></span>已完成</span>';
    if (state === 'doing') return '<span class="chip tone-primary" style="height:26px"><span class="dot"></span>进行中</span>';
    if (state === 'manual') return '<span class="chip tone-warn" style="height:26px"><span class="dot"></span>需人工</span>';
    return '<span class="chip" style="height:26px"><span class="dot"></span>未开始</span>';
  }

  function renderCourses() {
    const grid = $('#courseGrid');
    if (!grid) return;
    grid.innerHTML = COURSES.map((c) => {
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      return (
        '<button class="card filled clickable course-card" data-selected="' + (c.id===selectedCourse) + '" aria-pressed="' + (c.id===selectedCourse) + '" data-course="' + escapeHtml(c.id) + '">' +
          (c.cover ? '<img class="course-cover" src="'+escapeHtml(c.cover)+'" alt="课程封面" loading="lazy">' : '') +
          (c.id===selectedCourse ? '<span class="current-tag">✓ 当前课程</span>' : '') +
          '<div class="cc-top">' +
            '<span class="cc-icon">' + courseIcon() + '</span>' +
            '<span class="cc-name">' + escapeHtml(c.name) + '</span>' +
          '</div>' +
          '<div class="cc-meta">' + stateChip(c.state) +
            '<span>' + (c.total == null ? '点击读取章节' : c.done + '/' + c.total + ' 任务点') + '</span>' +
          '</div>' +
          '<div class="cc-foot">' +
            (c.total==null ? '<span class="t-on-surface-variant">进度未读取</span>' : '<div class="progress" role="progressbar" aria-valuenow="'+c.done+'" aria-valuemax="'+c.total+'"><i style="width:'+pct+'%"></i></div>') +
            '<span class="cc-pct">' + (c.total == null ? '—' : pct + '%') + '</span>' +
          '</div>' +
        '</button>'
      );
    }).join('');

    $$('#courseGrid .course-card').forEach((el) => {
      el.addEventListener('click', () => {
        selectCourse(el.dataset.course);
      });
    });
  }

  // ---------------- 渲染：章节 ----------------
  let chapterFilter = 'all';

  function renderChapters() {
    const box = $('#chapterList');
    if (!box) return;
    const list = chapterFilter === 'all' ? CHAPTERS : CHAPTERS.filter((c) => c.state !== 'done');
    box.innerHTML = list.map((c) =>
      '<button class="chapter" data-chapter="' + escapeHtml(c.key||'') + '" data-state="' + c.state + '"' + (c.current ? ' data-current="true"' : '') + (c.locked?' disabled':'') + '>' +
        '<span class="ch-dot"></span>' +
        '<span class="ch-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="ch-count">' + ({done:'全部完成',video:'仅视频完成',quiz:'仅测验完成',todo:'未完成',unknown:'待确认'}[c.state]||'待确认') + '</span>' +
      '</button>'
    ).join('');
  }

  // ---------------- 渲染：队列 ----------------
  function renderQueue() {
    const box = $('#queueList');
    if (!box) return;
    box.innerHTML = QUEUE.map((q) =>
      '<div class="queue-item">' +
        '<span class="pulse"' + (q.state === 'doing' ? ' data-live="true"' : '') + ' style="' +
          (q.state === 'doing' ? '' : 'background:var(--md-sys-color-outlineVariant)') + '"></span>' +
        '<div class="qi-main">' +
          '<div class="qi-name">' + q.name + '</div>' +
          '<div class="qi-sub">' + q.sub + '</div>' +
        '</div>' +
        (q.state === 'doing'
          ? '<span class="chip tone-primary" style="height:24px">处理中</span>'
          : '<span class="chip" style="height:24px">未开始</span>') +
      '</div>'
    ).join('');
  }

  // ---------------- 渲染：异常 ----------------
  function renderIssues() {
    const box = $('#issueBox');
    if (!box) return;
    if (!ISSUES.length) {
      box.innerHTML = '<div class="t-body-small t-on-surface-variant" style="padding:8px 0">当前没有需要处理的异常</div>';
      return;
    }
    box.innerHTML = ISSUES.map((i) =>
      '<div class="issue-item" data-kind="' + (i.kind === 'error' ? 'error' : 'warn') + '">' +
        '<div class="ii-main">' +
          '<div class="ii-title">' + i.title + '</div>' +
          '<div class="ii-fix">' + i.fix + '</div>' +
        '</div>' +
      '</div>'
    ).join('');
  }

  // ---------------- 日志 ----------------
  function pushLog(line) {
    // main 进程通过 ui:log 推来的行：{ time, level, text }
    const t = (line && (line.time || line.at)) || new Date().toTimeString().slice(0, 8);
    const lvl = (line && (line.level || line.kind)) || 'info';
    const text = String((line && (line.text || line.message || line.line)) || '');
    if (!text) return;
    LOGS.push([t, lvl, text]);
    if (LOGS.length > 500) LOGS.splice(0, LOGS.length - 500);
    const box = $('#logList');
    if (box) {
      const d = document.createElement('div');
      d.className = 'logline';
      d.dataset.level = lvl;
      const st = document.createElement('span');
      st.className = 'lt';
      st.textContent = t;
      const sm = document.createElement('span');
      sm.className = 'lm';
      sm.textContent = text;
      d.appendChild(st);
      d.appendChild(sm);
      box.appendChild(d);
      box.scrollTop = box.scrollHeight;
    }
  }

  function renderLogs() {
    const box = $('#logList');
    if (!box) return;
    box.innerHTML = LOGS.map(([t, lvl, m]) =>
      '<div class="logline" data-level="' + lvl + '"><span class="lt">' + t + '</span><span class="lm">' + m + '</span></div>'
    ).join('');
  }

  // ============================================================ 真实数据接入
  // 有 __cxApp 时走真实 IPC；浏览器直开时退回预览数据。

  function loadPreview() {
    COURSES = PREVIEW_COURSES.slice();
    CHAPTERS = PREVIEW_CHAPTERS.slice();
    QUEUE = PREVIEW_QUEUE.slice();
    ISSUES = PREVIEW_ISSUES.slice();
    LOGS = PREVIEW_LOGS.slice();
    TODAY = { playSeconds: 11520, visionCalls: 0, visionFail: 0, promptTokens: 0, completionTokens: 0, tasksConfirmed: 24 };
    MODEL = { hasKey: true, keySource: 'app', keyMasked: 'sk-****4f2a' };
  }

  // 从页面读 Runner 快照（沿用旧界面的做法）
  async function readRunner() {
    if (!App || typeof App.evalMain !== 'function') return { mounted: false, snap: {} };
    try {
      const r = await App.evalMain(
        '(function(){' +
          'var a=window.__cxNaturalWatchApp;' +
          'if(!a||!a.runner)return {mounted:false};' +
          'try{return {mounted:true,snap:a.runner.snapshot()};}catch(e){return {mounted:false};}' +
        '})()'
      );
      if (!r || !r.ok) return { mounted: false, snap: {} };
      return r.result || { mounted: false, snap: {} };
    } catch (e) {
      return { mounted: false, snap: {} };
    }
  }

  async function loadCourses() {
    if (!App || typeof App.courseOverview !== 'function') return;
    if (App.coursesList) {
      const catalog = await App.coursesList();
      if (catalog && catalog.ok) {
        PROFILE=catalog.profile||PROFILE;renderAccount();
        COURSES = catalog.courses.map(c => ({...c,total:c.progress?.summary?.total??null,done:c.progress?.summary?.done??0,state:c.id === selectedCourse ? (RUNNER.snap?.state === 'playing' ? 'doing' : 'selected') : 'unknown'}));
        const counter = $('#courseCount'); if (counter) counter.textContent = String(COURSES.length);
      }
    }
    try {
      const r = await App.courseOverview();
      const d = r && r.ok ? r.data : null;
      if (!d || !d.ok) return;
      const items = Array.isArray(d.items) ? d.items : [];
      const heading=document.querySelector('.page[data-page="workspace"] h1');if(heading)heading.textContent=COURSES.find(c=>c.id===selectedCourse)?.name||'当前课程';
      const sum = d.summary || {};
      const cursor = d.cursor || {};
      const total = Number(sum.total) || items.length;
      const done = Number(sum.done) || 0;

      CHAPTERS = items.map((it,index) => ({
        key:it.key||'tree-'+index,locked:!!it.locked,
        name: String(it.title || '').replace(/\s*\d+\s*个待完成\s*$/, '').trim() || '(未命名章节)',
        state:it.complete===true||it.pending===0?'done':it.videoDone===true&&it.quizDone===false?'video':it.videoDone===false&&it.quizDone===true?'quiz':it.videoDone===false&&it.quizDone===false?'todo':'unknown',
        pending: it.pending || 0,
        current: cursor.jobTitle ? it.title.indexOf(String(cursor.jobTitle).slice(0, 12)) >= 0 : false,
      }));

      if (!App.coursesList) COURSES = [
        {
          id: 'current',
          name: cursor.courseName || (CHAPTERS[0] ? '当前课程' : '尚未进入课程'),
          teacher: '',
          total: total,
          done: done,
          state: done >= total && total > 0 ? 'done' : 'doing',
          current: cursor.jobTitle || '',
        },
      ];
    } catch (e) {
      /* ignore */
    }
  }

  async function loadTasks() {
    if (!App || typeof App.tasksList !== 'function') return;
    try {
      const r = await App.tasksList();
      const list = r && r.ok && Array.isArray(r.tasks) ? r.tasks : [];
      QUEUE = list.map((t) => ({
        id: t.id,
        name: t.chapterTitle || t.courseName || '(未命名)',
        sub: (t.type === 'quiz' ? '测验' : '视频') + ' · ' + ({ 2: '高', 1: '中', 0: '低' }[t.priority] || '中') + '优先级',
        state: t.status === 'doing' ? 'doing' : t.status === 'done' ? 'done' : t.status === 'manual' ? 'manual' : 'todo',
      }));
    } catch (e) {
      /* ignore */
    }
  }

  async function loadStats() {
    if (!App || typeof App.statsGet !== 'function') return;
    try {
      const r = await App.statsGet();
      if (r && r.ok && r.today) TODAY = Object.assign(TODAY, r.today);
    } catch (e) {
      /* ignore */
    }
  }

  async function loadModel() {
    if (!App || typeof App.visionStatus !== 'function') return;
    try {
      const s = await App.visionStatus();
      if (s) MODEL = { hasKey: !!s.hasKey, keySource: s.keySource || '', keyMasked: s.keyMasked || '' };
    } catch (e) {
      /* ignore */
    }
  }

  async function loadRunnerState() {
    const d = await readRunner();
    RUNNER = d;
    const s = d.snap || {};
    playing = !!d.mounted && ['playing','locating','settling','advancing'].includes(s.state);
    const onCourse = !!d.mounted;

    // 顶栏上下文
    const ctxCourse = $('#ctxCourse');
    const ctxState = $('#ctxState');
    if (ctxCourse && onCourse && s.jobTitle) ctxCourse.textContent = String(s.jobTitle).slice(0, 40);
    if (ctxState) {
      ctxState.textContent = onCourse ? (s.stateLabel || s.state || '就绪') : CHAPTERS.length?'章节已读取':'正在读取课程';
    }

    // 工作区当前播放
    const nowState = $('#nowState');
    const nowChapter = $('#nowChapter');
    const nowRing = $('#nowRing');
    if (nowState) nowState.textContent = onCourse ? (s.stateLabel || '就绪') : CHAPTERS.length?'可以开始学习':'正在读取章节';
    if (nowChapter) {
      const v = s.video || {};
      const pct = v.duration > 0 ? Math.round(((v.currentTime || 0) / v.duration) * 100) : 0;
      nowChapter.textContent = onCourse
        ? (s.jobTitle || '') + (v.duration > 0 ? ' · ' + pct + '%' : '')
        : CHAPTERS.length?'点击开始，自动打开待完成章节':'课程目录加载完成后会自动显示';
    }
    if (nowRing) {
      const v = s.video || {};
      const pct = v.duration > 0 ? Math.round(((v.currentTime || 0) / v.duration) * 100) : 0;
      nowRing.style.setProperty('--p', String(pct));
    }

    // 异常：按状态归类
    const issues = [];
    if (!MODEL.hasKey) {
      issues.push({ kind: 'warn', title: '未配置 API Key', fix: '在「模型」页粘贴 Key 后测试连接' });
    }
    if (onCourse && s.state === 'blocked') {
      issues.push({ kind: 'error', title: '任务已阻塞', fix: '查看左侧日志；必要时点「暂停」再「继续」' });
    }
    if (onCourse && s.state === 'awaitingConfirm') {
      issues.push({ kind: 'warn', title: '等待人工确认', fix: '平台未确认完成，可点继续重试或停止跳过' });
    }
    ISSUES = issues;
  }

  async function loadAll() {
    if (IS_PREVIEW) {
      loadPreview();
      return;
    }
    await Promise.all([loadModel(), loadCourses(), loadTasks(), loadStats()]);
    await loadRunnerState();
  }

  function renderAll() {
    renderCourses();
    renderSideCourses();
    renderAccount();
    renderChapters();
    renderQueue();
    renderIssues();
    renderLogs();
    renderStats();
  }

  // 统计条 + 账户区
  function renderStats() {
    const fmt = (sec) => {
      const s = Math.max(0, Math.round(Number(sec) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (h > 0) return h + ' 小时 ' + m + ' 分';
      if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒';
      return s + ' 秒';
    };
    const tok = (TODAY.promptTokens || 0) + (TODAY.completionTokens || 0);
    const tokText = tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : String(tok);

    const set = (id, v) => {
      const el = $(id);
      if (el) el.textContent = v;
    };
    set('#stPlayed', fmt(TODAY.playSeconds));
    set('#stConfirmed', String(TODAY.tasksConfirmed || 0));
    set('#stPending', String(CHAPTERS.reduce((n, c) => n + (c.pending || 0), 0)));
    set('#stTokens', tokText);

    set('#accPlay', fmt(TODAY.playSeconds).replace(' ', ''));
    set('#accTok', tokText);
    set('#accCost', '¥' + (tok * 0.000002).toFixed(2));

    const note = $('#accNote');
    if (note) {
      note.textContent = MODEL.hasKey
        ? '已配置 API Key · ' + (MODEL.keySource === 'app' ? '本机加密存储' : MODEL.keySource === 'env' ? '环境变量' : '本机配置')
        : '未配置 API Key，无法自动答题';
    }

    const badge = $('#navLearnBadge');
    if (badge) badge.textContent = String(CHAPTERS.reduce((n, c) => n + (c.pending || 0), 0));
  }


  function updateKeyHint() {
    const hint = $('#keyHint');
    if (!hint) return;
    if (MODEL.hasKey) {
      const src =
        MODEL.keySource === 'app' ? '本机加密存储' : MODEL.keySource === 'env' ? '环境变量' : '本机配置';
      hint.textContent = '已配置 · ' + (MODEL.keyMasked || '') + ' · ' + src;
      hint.style.color = 'var(--md-sys-color-primary)';
    } else {
      hint.textContent = '未配置。粘贴 DeepSeek API Key 后即可自动答题';
      hint.style.color = 'var(--md-sys-color-error)';
    }
  }

  // ---------------- FAB ----------------
  let playing = false;

  function updateFab() {
    const fab = $('#fab');
    const label = $('#fabLabel');
    if (!fab || !label) return;
    const onWorkspace = currentPage === 'workspace';
    fab.style.display = ['settings','about'].includes(currentPage)?'none':'inline-flex';
    if (onWorkspace) {
      playing ? (label.textContent = '暂停') : (label.textContent = '继续');
      fab.classList.toggle('is-playing', playing);
      fab.querySelector('svg').innerHTML = playing
        ? '<path d="M9 5v14M15 5v14"/>'
        : '<path d="M8 5l11 7-11 7z"/>';
    } else {
      label.textContent = '开始学习';
      fab.classList.remove('is-playing');
      fab.querySelector('svg').innerHTML = '<path d="M8 5l11 7-11 7z"/>';
    }
  }

  // ---------------- Snackbar ----------------
  let snackTimer = null;

  function snack(text) {
    const el = $('#snackbar');
    const t = $('#snackText');
    if (!el || !t) return;
    t.textContent = text;
    el.dataset.open = 'true';
    if (snackTimer) clearTimeout(snackTimer);
    snackTimer = setTimeout(() => {
      el.dataset.open = 'false';
    }, 3200);
  }

  // ---------------- Dialog ----------------
  function openDialog(title, body, onOk) {
    const scrim = $('#scrim');
    const t = $('#dlgTitle');
    const b = $('#dlgBody');
    const ok = $('#dlgOk');
    if (!scrim) return;
    t.textContent = title;
    b.textContent = body;
    scrim.dataset.open = 'true';
    ok.onclick = () => {
      scrim.dataset.open = 'false';
      if (typeof onOk === 'function') onOk();
    };
  }

  function closeDialog() {
    const scrim = $('#scrim');
    if (scrim) scrim.dataset.open = 'false';
  }

  // ---------------- 主题 ----------------
  function renderSeedRow() {
    const row = $('#seedRow');
    if (!row) return;
    const cur = window.CxTheme.get().seed;
    row.innerHTML = SEEDS.map((s) =>
      '<button class="seeddot" data-seed="' + s + '" aria-selected="' + (s === cur) + '" style="background:' + s + '"></button>'
    ).join('');
    $$('#seedRow .seeddot').forEach((el) => {
      el.addEventListener('click', () => {
        window.CxTheme.setSeed(el.dataset.seed);
        renderSeedRow();
        renderPalette();
        snack('配色已切换');
      });
    });
  }

  function renderPalette() {
    const strip = $('#paletteStrip');
    if (!strip) return;
    const pal = window.CxTheme.palette();
    const tones = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95];
    strip.innerHTML = tones.map((t) => '<i style="background:' + pal.p[t] + '"></i>').join('');
  }

  function bindTheme() {
    const t = $('#btnTheme');
    if (t) {
      t.addEventListener('click', () => {
        window.CxTheme.toggle();
        syncDarkSwitch();
      });
    }

    const s = $('#btnSeed');
    if (s) {
      s.addEventListener('click', () => {
        const i = Math.floor(Math.random() * SEEDS.length);
        window.CxTheme.setSeed(SEEDS[i]);
        renderSeedRow();
        renderPalette();
        snack('随机配色：' + SEEDS[i]);
      });
    }

    const dt = $('#darkToggle');
    if (dt) {
      dt.addEventListener('change', () => {
        window.CxTheme.setDark(dt.checked);
        syncDarkSwitch();
      });
    }

    document.addEventListener('theme-change', () => renderPalette());
  }

  function syncDarkSwitch() {
    const dt = $('#darkToggle');
    if (dt) dt.checked = window.CxTheme.get().dark;
  }

  async function selectCourse(id) {
    if (!App?.courseOpen) return;
    selectedCourse = id;renderCourses();renderSideCourses();CHAPTERS=[];RUNNER={mounted:false,snap:{}};renderChapters();
    const selected=COURSES.find(c=>c.id===id);if($('#ctxCourse'))$('#ctxCourse').textContent=selected?.name || '课程';
    goto('workspace'); snack('正在打开课程…');
    try {
      const r=await App.courseOpen(id);
      if (!r?.ok) { snack(r?.error || '课程打开失败'); return; }
      await loadRunnerState(); await loadCourses(); renderChapters(); await pollCourseStatus();
    } catch(e) {snack('课程打开失败：'+e.message);}
  }
  async function pollCourseStatus() {
    if (!App?.courseStatus) return;
    const state=await App.courseStatus();
    const panel=$('#verificationPanel'), image=$('#verificationImage'), message=$('#verificationText');
    if (!panel) return;
    const verify=state.verification;
    panel.hidden=!verify || ['settings','about'].includes(currentPage);
    if (verify) {
      message.textContent=verify.expired ? '平台二维码已过期，等待自动更新；也可显示原网页刷新。' : verify.kind==='face' ? '使用手机 App 扫码并完成人脸验证。验证结果由平台确认。' : '使用手机 App 扫码登录。';
      if (verify.image) { image.src=verify.image;image.hidden=false; } else {image.removeAttribute('src');image.hidden=true;message.textContent+=' 暂未能读取二维码，可显示原网页处理。';}
    } else {image.removeAttribute('src');image.hidden=true;}
    const status=$('#backgroundStatus');
    if (status) status.textContent=state.error || ({loading:'正在加载课程…',catalog:'选择课程开始学习。',chapters:'章节已读取，可以开始学习。',complete:'可读取的章节均已完成。',opening:'正在读取章节…',ready:'准备好了，可以开始学习。',running:'正在学习。',verification:'在手机上完成验证后即可继续。',login:'登录后即可加载课程。'}[state.phase] || '');
  }
  let autoUpdateTimer=null,updateUrl='';
  async function checkUpdates(automatic=false) {
    if(!App?.checkUpdates)return;
    const result=$('#updateResult');if(!automatic&&result)result.textContent='正在检查 GitHub…';
    const r=await App.checkUpdates();
    if(!r.ok){if(!automatic){if(result)result.textContent=r.error;snack(r.error)}return;}
    const text=r.available?'发现新版本 '+r.latest:'当前无需更新（本机 '+r.current+'，GitHub '+r.latest+'）';
    if(result)result.textContent=text;updateUrl=r.url;
    if($('#openUpdate'))$('#openUpdate').hidden=!r.available;
    if(!automatic||r.available)snack(text);
  }
  function bindNight() {
    const button=$('#btnNight'),capsule=$('#nightCountdown'),label=$('#nightCountdownText');
    if(!button||!capsule||!label)return;
    let state={pending:false,active:false,executeAt:0,error:''},busy=false,checking=false;
    const render=()=>{
      button.setAttribute('aria-checked',String(!!(state.pending||state.active)));
      button.title=state.pending?'取消息屏倒计时':state.active?'退出夜间模式':'30 秒后息屏并将课程网页静音';
      capsule.hidden=!state.pending&&!state.error;
      if(state.error)label.textContent='息屏未完成';
      else if(state.pending){const seconds=Math.max(0,Math.ceil((state.executeAt-Date.now())/1000));label.textContent=seconds?seconds+' 秒后息屏':'正在息屏…';}
    };
    const refresh=async()=>{if(checking||!App?.nightStatus)return;checking=true;try{state=await App.nightStatus();render();}catch{}finally{checking=false}};
    const cancel=async()=>{
      if(busy||!App?.nightCancel)return;busy=true;
      try{const result=await App.nightCancel();if(!result?.ok){snack('取消失败，请重试');return;}state={pending:false,active:false,executeAt:0,error:''};render();snack('夜间模式已关闭');}
      catch{snack('取消失败，请重试');}
      finally{busy=false;}
    };
    button.addEventListener('click',async()=>{
      if(state.pending||state.active){await cancel();return;}
      if(busy)return;if(!App?.nightSchedule){snack('仅桌面客户端支持夜间模式');return;}
      busy=true;
      try{const result=await App.nightSchedule(30000);if(!result?.ok){snack('夜间模式开启失败');return;}state={pending:true,active:false,executeAt:result.executeAt,error:''};render();}
      catch{snack('夜间模式开启失败');}finally{busy=false;}
    });
    $('#cancelNight')?.addEventListener('click',()=>cancel().catch(()=>snack('取消失败')));
    App?.onNight?.(next=>{state=next;render();if(next.error)snack('息屏或网页静音未完成，可关闭夜间模式后重试');});
    setInterval(()=>{render();if(state.pending&&Date.now()>=state.executeAt)refresh();},1000);
    refresh();render();
  }
  async function bindProduct() {
    document.querySelectorAll('[data-link]').forEach(b=>b.addEventListener('click',()=>App?.openExternal(b.dataset.link)));
    const info=await App?.appInfo?.();if($('#aboutVersion'))$('#aboutVersion').textContent='版本 '+(info?.version||'预览');
    const prefs=await App?.preferences?.();
    for(const id of ['defaultWebMuted','autoCheckUpdates']){const e=$('#'+id);if(!e)continue;e.checked=!!prefs?.[id];e.addEventListener('change',async()=>{await App?.preferences({[id]:e.checked});if(id==='autoCheckUpdates')scheduleAuto();snack('设置已保存')});}
    function scheduleAuto(){clearTimeout(autoUpdateTimer);if($('#autoCheckUpdates')?.checked)autoUpdateTimer=setTimeout(()=>checkUpdates(true).catch(()=>{}),12000);}
    $('#checkUpdateSettings')?.addEventListener('click',()=>checkUpdates(false).catch(()=>snack('检查失败')));
    $('#openUpdate')?.addEventListener('click',()=>App?.openExternal(updateUrl));scheduleAuto();
  }
  async function windowAction(action) {
    if (!App || !App.windowControl) { snack('仅桌面客户端支持此操作'); return; }
    try { const r = await App.windowControl(action); if (!r || !r.ok) snack('窗口操作失败'); }
    catch (e) { snack('窗口操作失败：' + e.message); }
  }
  async function runnerAction(method) {
    if (!App || !App.evalMain) { snack('预览模式不执行课程任务'); return; }
    try {
      if ((method==='pause'||method==='stop') && App.courseCancelStart) await App.courseCancelStart();
      if (method==='start' && !RUNNER.mounted && App.courseStart) {
        const r=await App.courseStart();snack(r.ok ? (r.pending ? '正在准备课程，完成验证后会自动开始' : '已启动') : r.error);await pollCourseStatus();return;
      }
      const code = '(async()=>{const a=window.__cxNaturalWatchApp;if(!a||!a.runner)return {ok:false,error:"请先显示网页并进入课程学习页"};await a.runner[' + JSON.stringify(method) + ']();return {ok:true}})()';
      const r = await App.evalMain(code);
      if (!r || !r.ok || !r.result || !r.result.ok) { snack((r && r.result && r.result.error) || '任务操作失败'); return; }
      await loadRunnerState(); updateFab(); snack({start:'已启动',pause:'已暂停',resume:'已继续',stop:'已停止'}[method]);
    } catch (e) { snack('任务操作失败：' + e.message); }
  }
  async function refreshCourses() {
    if (App?.coursesRefresh) {const result=await App.coursesRefresh();if(!result.ok){snack(result.error || '读取失败');return;}}
    await loadCourses(); renderCourses(); renderSideCourses(); renderChapters();
    snack(COURSES.length ? '课程数据已更新' : '请先显示网页并进入课程学习页');
  }
  // ---------------- 事件绑定 ----------------
  function bind() {
    $('#chapterList')?.addEventListener('click',async event=>{
      const button=event.target.closest('[data-chapter]');if(!button||!App?.openChapter)return;
      const chapter=CHAPTERS.find(c=>c.key===button.dataset.chapter);if(!chapter)return;
      const result=await App.openChapter({key:chapter.key,title:chapter.name}).catch(()=>({ok:false,error:'章节打开失败'}));
      snack(result.ok?'正在打开章节…':result.error);await pollCourseStatus();
    });
    $$('.sideitem[data-nav]').forEach((el) => {
      el.addEventListener('click', () => goto(el.dataset.nav));
    });

    const fab = $('#fab');
    if (fab) {
      fab.addEventListener('click', () => { goto('workspace'); runnerAction(playing ? 'pause' : RUNNER.snap?.state === 'paused' ? 'resume' : 'start'); });
    }

    const min = $('#winMin');
    const max = $('#winMax');
    const close = $('#winClose');
    if (min) min.addEventListener('click', () => windowAction('minimize'));
    if (max) max.addEventListener('click', () => windowAction('maximize'));
    if (close) close.addEventListener('click', () => windowAction('hide'));

    const ss = $('#sideStart');
    if (ss) ss.addEventListener('click', () => { goto('workspace'); runnerAction('start'); });

    const gr = $('#gRefresh');
    if (gr) gr.addEventListener('click', refreshCourses);

    const gs = $('#gSearch');
    if (gs) gs.addEventListener('click', () => snack('当前版本尚未接入课程搜索'));

    const sync = $('#btnScan');
    if (sync) sync.addEventListener('click', refreshCourses);

    $$('#wkTabs .wktab').forEach((tab) => {
      tab.addEventListener('click', () => {
        chapterFilter = tab.dataset.wk;
        $$('#wkTabs .wktab').forEach((x) => x.setAttribute('aria-selected', String(x === tab)));
        renderChapters();
      });
    });

    // 顶栏「应用」菜单
    const tbApp = $('#tbApp');
    const appMenu = $('#appMenu');
    if (tbApp && appMenu) {
      const place = () => {
        const r = tbApp.getBoundingClientRect();
        appMenu.style.left = Math.round(r.left) + 'px';
        appMenu.style.top = Math.round(r.bottom + 6) + 'px';
      };
      tbApp.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = appMenu.dataset.open === 'true';
        if (open) { appMenu.dataset.open = 'false'; tbApp.setAttribute('aria-expanded', 'false'); }
        else { place(); appMenu.dataset.open = 'true'; tbApp.setAttribute('aria-expanded', 'true'); }
      });
      document.addEventListener('click', (e) => {
        if (appMenu.dataset.open === 'true' && !appMenu.contains(e.target) && e.target !== tbApp) {
          appMenu.dataset.open = 'false';
          tbApp.setAttribute('aria-expanded', 'false');
        }
      });
      $$('#appMenu .mi').forEach((el) => {
        el.addEventListener('click', () => {
          const mi = el.dataset.mi;
          appMenu.dataset.open = 'false';
          tbApp.setAttribute('aria-expanded', 'false');
          if (mi === 'settings') goto('settings');
          else if (mi === 'tray') windowAction('hide');
          else if (mi === 'check') checkUpdates(false);
          else if (mi === 'about') goto('about');
          else if (mi === 'quit') openDialog('退出程序', '退出后自动化会停止。确定退出？', () => windowAction('quit'));
        });
      });
    }

    const tbEdit = $('#tbEdit');
    if (tbEdit) tbEdit.addEventListener('click', () => snack('（原型）编辑菜单'));

    // 「更多」= 显示/隐藏学习通网页。默认隐藏，自动化在后台继续跑。
    const btnMore = $('#btnMore');
    if (btnMore) {
      btnMore.addEventListener('click', async () => {
        try {
          if (App && typeof App.toggleWeb === 'function') {
            const r = await App.toggleWeb();const label=$('#webPillLabel');if(label)label.textContent=r.visible?'隐藏网页':'网页';
            snack(r && r.visible ? '已显示网页（用于登录 / 扫码）' : '已隐藏网页，自动化继续在后台运行');
          } else {
            snack('预览模式：正式版这里会切换网页显示');
          }
        } catch (e) {
          snack('切换失败：' + ((e && e.message) || e));
        }
      });
    }

    const tbCol = $('#tbCollapse');
    const appEl = $('#app');
    if (tbCol && appEl) {
      tbCol.addEventListener('click', () => {
        const on = appEl.dataset.collapsed === 'true';
        appEl.dataset.collapsed = String(!on);
      });
    }

    const nt = $('#navTray');
    if (nt) {
      nt.addEventListener('click', () =>
        openDialog('收进托盘', '关闭窗口后程序会在托盘继续运行，右键托盘图标可暂停、结束或退出。', () => windowAction('hide'))
      );
    }

    const qa = $('#btnQueueAdd');
    if (qa) {
      qa.addEventListener('click', async () => {
        if (!App || !App.tasksAdd) { snack('预览模式不保存任务'); return; }
        await loadCourses();
        if (!CHAPTERS.length) { snack('请先进入章节学习页再导入任务'); return; }
        await loadTasks(); let added = 0;
        for (const chapter of CHAPTERS) {
          if (QUEUE.some(t => t.name === chapter.name)) continue;
          const result = await App.tasksAdd({courseName:COURSES[0]?.name || '',chapterTitle:chapter.name,type:'all',priority:chapter.pending ? 2 : 1,status:'todo'});
          if (!result || !result.ok) { snack('导入失败，已导入 ' + added + ' 项'); return; }
          added++;
        }
        await loadTasks(); renderQueue(); snack('已导入 ' + added + ' 个章节');
      });
    }

    const dlgCancel = $('#dlgCancel');
    if (dlgCancel) dlgCancel.addEventListener('click', closeDialog);
    const scrim = $('#scrim');
    if (scrim) scrim.addEventListener('click', (e) => { if (e.target === scrim) closeDialog(); });

    const sn = $('#snackAction');
    if (sn) sn.addEventListener('click', () => { $('#snackbar').dataset.open = 'false'; });

    const bl = $('#btnSaveKey');
    if (bl) {
      bl.addEventListener('click', async () => {
        const input = $('#apiKey');
        const key = String((input && input.value) || '').trim();
        if (!key) return snack('请先粘贴 API Key');
        if (!App || typeof App.setModelKey !== 'function') return snack('预览模式：正式版会加密保存');
        const r = await App.setModelKey(key);
        if (r && r.ok) {
          if (input) input.value = '';
          MODEL = { hasKey: true, keySource: 'app', keyMasked: (r && r.masked) || '' };
          updateKeyHint();
          renderStats();
          snack('已保存（加密存储）');
        } else {
          snack('保存失败：' + ((r && r.error) || '未知错误'));
        }
      });
    }

    const bt = $('#btnTestKey');
    if (bt) {
      bt.addEventListener('click', async () => {
        if (!App || typeof App.testModel !== 'function') return snack('预览模式：连接正常 · 412ms');
        snack('正在测试连接…');
        const r = await App.testModel();
        if (r && r.ok) snack('连接正常 · ' + (r.elapsedMs || 0) + 'ms · ' + (r.model || ''));
        else snack('连接失败：' + ((r && r.error) || '未知错误'));
      });
    }

    const bc = $('#btnClearKey');
    if (bc) {
      bc.addEventListener('click', () =>
        openDialog('清除 Key', '清除后无法自动答题，确定？', async () => {
          if (App && typeof App.clearModelKey === 'function') await App.clearModelKey();
          MODEL = { hasKey: false, keySource: '', keyMasked: '' };
          updateKeyHint();
          renderStats();
          snack('已清除');
        })
      );
    }

    const bl2 = $('#btnClearLog');
    if (bl2) bl2.addEventListener('click', () => { LOGS.length = 0; renderLogs(); snack('日志已清空'); });

    const pz = $('#wkPause');
    if (pz) pz.addEventListener('click', () => runnerAction('pause'));
    const sp = $('#wkStop');
    if (sp) sp.addEventListener('click', () => openDialog('结束任务', '结束后当前章节会停在这里，可随时重新开始。', () => runnerAction('stop')));

    const nt2 = $('#nowToggle');
    if (nt2) nt2.addEventListener('click', () => runnerAction(playing ? 'pause' : RUNNER.snap?.state === 'paused' ? 'resume' : 'start'));

    // 内容滚动时显示顶部渐隐
    const main = $('#main');
    if (main) {
      main.addEventListener('scroll', () => {
        const p = $('.page[data-active="true"]');
        const top = p ? p.scrollTop : 0;
        main.dataset.scrolled = String(top > 4);
      }, true);
    }
  }

  // ---------------- 启动 ----------------
  // 给 IPC 调用加超时：任何一个不返回，也不能拖住整个界面
  function withTimeout(p, ms, fallback) {
    return Promise.race([
      Promise.resolve(p).catch(() => fallback),
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }

  async function loadAllSafe() {
    if (IS_PREVIEW) {
      loadPreview();
      return;
    }
    await Promise.all([
      withTimeout(loadModel(), 4000),
      withTimeout(loadCourses(), 6000),
      withTimeout(loadTasks(), 4000),
      withTimeout(loadStats(), 4000),
    ]);
    await withTimeout(loadRunnerState(), 4000);
  }

  async function init() {
    window.CxTheme.init();

    // 顺序很重要：先把事件绑上，界面立刻可交互。
    // 之前是先 await loadAll() 再 bind()，只要有一个 IPC 不返回，
    // bind 就永远不执行，表现出来就是"界面能看但点不动"。
    renderAll();
    renderSeedRow();
    renderPalette();
    syncDarkSwitch();
    bind();
    bindTheme();
    bindAccount();
    bindNight();
    bindProduct().catch(()=>{});
    $('#showVerificationWeb')?.addEventListener('click',()=>App?.toggleWeb(true));
    $('#hidePlatformWeb')?.addEventListener('click',()=>App?.toggleWeb(false));
    updateFab();

    // 再把真实数据补上（带超时，失败也不影响交互）
    loadAllSafe()
      .then(() => {
        renderAll();
        updateKeyHint();
      })
      .catch(() => {
        /* 已降级 */
      });

    // 实时日志
    if (App && typeof App.onLog === 'function') {
      try {
        App.onLog(pushLog);
      } catch (e) {
        /* ignore */
      }
    }

    // 支持 #workspace / #model / #logs 直达，方便单独预览某一页
    const hash = String(location.hash || '').replace('#', '');
    if (hash && ['dashboard', 'workspace', 'settings', 'about'].indexOf(hash) !== -1) {
      currentPage = '';
      goto(hash);
    }
    updateFab();

    if(App?.courseStatus){pollCourseStatus().catch(()=>{});setInterval(()=>pollCourseStatus().catch(()=>{}),1500);setInterval(()=>loadCourses().then(()=>{renderCourses();renderSideCourses();}).catch(()=>{}),5000);}

    // 定时刷新真实状态
    if (!IS_PREVIEW) {
      setInterval(async () => {
        await loadRunnerState();
        updateFab();
        renderIssues();
        renderCourses();
        renderSideCourses();
        renderChapters();
        renderQueue();
      }, 3000);
      setInterval(async () => {
        await loadStats();
        await loadModel();
        renderStats();
      }, 10000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
