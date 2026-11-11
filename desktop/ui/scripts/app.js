/* ===========================================================================
   app.js —— 原型交互（纯前端模拟数据，不连接真实 Electron）
   =========================================================================== */

(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---------------- 模拟数据 ----------------
  const COURSES = [
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

  const CHAPTERS = [
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

  const QUEUE = [
    { name: '1.2 习近平党建思想的核心要义', sub: '视频 · 高优先级', state: 'doing' },
    { name: '1.2 章节测验', sub: '测验 · 高优先级', state: 'todo' },
    { name: '1.3 深刻认识习近平党建思想…', sub: '视频 · 中优先级', state: 'todo' },
  ];

  const ISSUES = [
    { kind: 'warn', title: '本节有 1 个测验待提交', fix: '自动提交未开启。核对答案后手动提交，再点继续。' },
  ];

  const SEEDS = ['#4C6FFF', '#0F9D58', '#C2410C', '#7C3AED', '#0E7490', '#B91C1C'];

  // ---------------------------------------------------------------- 侧栏课程列表
function renderSideCourses() {
  const box = $('#sideCourses');
  if (!box) return;
  box.innerHTML = COURSES.map((c) => {
    const rel = c.state === 'done' ? '已完成' : c.state === 'doing' ? '进行中' : c.state === 'manual' ? '需人工' : '未开始';
    return (
      '<button class="lnk" data-course="' + c.id + '" data-state="' + c.state + '">' +
        '<span class="dot"></span>' +
        '<span class="lt">' + c.name + '</span>' +
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
  const play = $('#accPlay');
  const tok = $('#accTok');
  const cost = $('#accCost');
  const name = $('#accName');
  const ava = $('#accAvatar');
  if (play) play.textContent = '3h12m';
  if (tok) tok.textContent = '128.4k';
  if (cost) cost.textContent = '¥2.31';
  if (name) name.textContent = '许亦凡';
  if (ava) ava.textContent = '许';
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
      goto('model');
      close();
    }
  });

  $$('#userMenu .mi').forEach((el) => {
    el.addEventListener('click', () => {
      const mi = el.dataset.mi;
      close();
      if (mi === 'settings') goto('model');
      else if (mi === 'about') snack('课程伴学工具 v0.2.0 · 非官方兼容工具');
      else if (mi === 'logout')
        openDialog('退出登录', '退出后会清除本机保存的学习通登录状态，需要重新登录。确定？', () =>
          snack('（原型）已退出登录')
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
        '<button class="card filled clickable course-card" data-course="' + c.id + '">' +
          '<div class="cc-top">' +
            '<span class="cc-icon">' + courseIcon() + '</span>' +
            '<span class="cc-name">' + c.name + '</span>' +
          '</div>' +
          '<div class="cc-meta">' + stateChip(c.state) +
            '<span>' + c.done + '/' + c.total + ' 任务点</span>' +
          '</div>' +
          '<div class="cc-foot">' +
            '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
            '<span class="cc-pct">' + pct + '%</span>' +
          '</div>' +
        '</button>'
      );
    }).join('');

    $$('#courseGrid .course-card').forEach((el) => {
      el.addEventListener('click', () => {
        goto('workspace');
        snack('已切换到「' + COURSES.find((c) => c.id === el.dataset.course).name + '」');
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
      '<button class="chapter" data-state="' + c.state + '"' + (c.current ? ' data-current="true"' : '') + '>' +
        '<span class="ch-dot"></span>' +
        '<span class="ch-name">' + c.name + '</span>' +
        (c.pending ? '<span class="ch-count">' + c.pending + ' 待完成</span>' : '<span class="ch-count">已完成</span>') +
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
  const LOGS = [
    ['09:42:11', 'ok', '课程状态：正在播放'],
    ['09:42:10', 'info', '平台确认 1.1 任务点完成（24/59）'],
    ['09:41:58', 'info', '切换下一节：1.2 习近平党建思想的核心要义'],
    ['09:41:57', 'info', '视频播放结束，等待平台确认'],
    ['09:34:02', 'info', '开始自动刷课'],
    ['09:33:59', 'ok', '模型连接正常 · 412ms · deepseek-chat'],
    ['09:33:40', 'warn', '本节有未完成的章节测验，已填写但未提交'],
    ['09:33:12', 'info', '识别 1.1 章节测验：5 题，全部成功'],
    ['09:32:48', 'info', '读取到 31 个章节，59 个任务点'],
  ];

  function renderLogs() {
    const box = $('#logList');
    if (!box) return;
    box.innerHTML = LOGS.map(([t, lvl, m]) =>
      '<div class="logline" data-level="' + lvl + '"><span class="lt">' + t + '</span><span class="lm">' + m + '</span></div>'
    ).join('');
  }

  // ---------------- FAB ----------------
  let playing = true;

  function updateFab() {
    const fab = $('#fab');
    const label = $('#fabLabel');
    if (!fab || !label) return;
    const onWorkspace = currentPage === 'workspace';
    fab.style.display = 'inline-flex';
    if (onWorkspace) {
      playing ? (label.textContent = '暂停') : (label.textContent = '继续');
      fab.classList.toggle('is-playing', playing);
      fab.querySelector('svg').innerHTML = playing
        ? '<path d="M9 5v14M15 5v14"/>'
        : '<path d="M8 5l11 7-11 7z"/>';
    } else {
      label.textContent = '开始刷课';
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

  // ---------------- 事件绑定 ----------------
  function bind() {
    $$('.sideitem[data-nav]').forEach((el) => {
      el.addEventListener('click', () => goto(el.dataset.nav));
    });

    const fab = $('#fab');
    if (fab) {
      fab.addEventListener('click', () => {
        if (currentPage === 'workspace') {
          playing = !playing;
          updateFab();
          const st = $('#nowState');
          if (st) st.textContent = playing ? '正在播放' : '已暂停';
          const pulse = $('.pulse[data-live]');
          if (pulse) {
            if (playing) pulse.setAttribute('data-live', 'true');
            else pulse.removeAttribute('data-live');
          }
          snack(playing ? '继续播放' : '已暂停');
        } else {
          goto('workspace');
          snack('开始刷课');
        }
      });
    }

    const min = $('#winMin');
    const max = $('#winMax');
    const close = $('#winClose');
    if (min) min.addEventListener('click', () => snack('（原型）最小化'));
    if (max) max.addEventListener('click', () => snack('（原型）最大化'));
    if (close) close.addEventListener('click', () => { goto('dashboard'); snack('关闭窗口 = 收进托盘，刷课继续'); });

    const ss = $('#sideStart');
    if (ss) ss.addEventListener('click', () => { goto('workspace'); snack('开始刷课'); });

    const gr = $('#gRefresh');
    if (gr) gr.addEventListener('click', () => snack('已重新读取 4 门课程'));

    const gs = $('#gSearch');
    if (gs) gs.addEventListener('click', () => snack('（原型）搜索课程'));

    const sync = $('#btnScan');
    if (sync) sync.addEventListener('click', () => snack('已重新读取 4 门课程'));

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
          if (mi === 'settings') goto('model');
          else if (mi === 'tray') snack('已收进托盘，刷课继续');
          else if (mi === 'check') snack('已是最新版 0.2.0-beta.4');
          else if (mi === 'about') snack('课程伴学工具 v0.2.0 · 非官方兼容工具');
          else if (mi === 'quit') openDialog('退出程序', '退出后自动化会停止。确定退出？', () => snack('（原型）已退出'));
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
          if (window.App && typeof window.App.toggleWeb === 'function') {
            const r = await window.App.toggleWeb();
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
        openDialog('收进托盘', '关闭窗口后程序会在托盘继续运行，右键托盘图标可暂停、结束或退出。', () => snack('已收进托盘'))
      );
    }

    const qa = $('#btnQueueAdd');
    if (qa) {
      qa.addEventListener('click', () => {
        QUEUE.push({ name: '新任务（示例）', sub: '视频 · 中优先级', state: 'todo' });
        renderQueue();
        snack('已添加任务');
      });
    }

    const dlgCancel = $('#dlgCancel');
    if (dlgCancel) dlgCancel.addEventListener('click', closeDialog);
    const scrim = $('#scrim');
    if (scrim) scrim.addEventListener('click', (e) => { if (e.target === scrim) closeDialog(); });

    const sn = $('#snackAction');
    if (sn) sn.addEventListener('click', () => { $('#snackbar').dataset.open = 'false'; });

    const bl = $('#btnSaveKey');
    if (bl) bl.addEventListener('click', () => snack('已保存（加密存储）'));
    const bt = $('#btnTestKey');
    if (bt) bt.addEventListener('click', () => snack('连接正常 · 412ms · deepseek-chat'));
    const bc = $('#btnClearKey');
    if (bc) bc.addEventListener('click', () => openDialog('清除 Key', '清除后无法自动答题，确定？', () => snack('已清除')));

    const bl2 = $('#btnClearLog');
    if (bl2) bl2.addEventListener('click', () => { LOGS.length = 0; renderLogs(); snack('日志已清空'); });

    const pz = $('#wkPause');
    if (pz) pz.addEventListener('click', () => snack('已暂停'));
    const sp = $('#wkStop');
    if (sp) sp.addEventListener('click', () => openDialog('结束任务', '结束后当前章节会停在这里，可随时重新开始。', () => snack('已结束')));

    const nt2 = $('#nowToggle');
    if (nt2) nt2.addEventListener('click', () => { playing = !playing; updateFab(); snack(playing ? '继续播放' : '已暂停'); });

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
  function init() {
    window.CxTheme.init();
    renderCourses();
    renderSideCourses();
    renderAccount();
    renderChapters();
    renderQueue();
    renderIssues();
    renderLogs();
    renderSeedRow();
    renderPalette();
    syncDarkSwitch();
    bind();
    bindTheme();
    bindAccount();
    // 支持 #workspace / #model / #logs 直达，方便单独预览某一页
    const hash = String(location.hash || '').replace('#', '');
    if (hash && ['dashboard', 'workspace', 'model', 'logs'].indexOf(hash) !== -1) {
      currentPage = '';
      goto(hash);
    }
    updateFab();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
