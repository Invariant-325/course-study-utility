// ==UserScript==
// @name         课程伴学工具（自然播放版）
// @namespace    local.chaoxing.natural-watch
// @version      0.1.4
// @description  按平台正常规则连播课程视频（默认 1.0 倍速），播完自动切下一个视频与章节；不改进度、不改倍速、不绕过检测。
// @author       local
// @license      MIT
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc-ans/knowledge/cards*
// @match        *://*.chaoxing.com/mooc-ans/work/doHomeWorkNew*
// @match        *://*.xuexitong.com/mycourse/studentstudy*
// @match        *://*.xuexitong.com/mooc-ans/knowledge/cards*
// @match        *://*.xuexitong.com/mooc-ans/work/doHomeWorkNew*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

// 注入范围说明（2026-11-10 实机验证后收窄）：
//   ✅ /mycourse/studentstudy      唯一确认可工作的学习页（三层同源）
//   ⚠️ /mooc-ans/knowledge/cards   学习页内层 iframe；@noframes 下不会作为顶层注入，
//                                  保留仅为容错（若将来放开子框架注入）
//   ❌ /mooc2-ans/mycourse/*       课程主页壳子：document.domain 不对称导致
//                                  #frame_content-zj 跨域不可读，目录与任务点都在里面，
//                                  在该页启动必然失败，故不再注入。
/* 构建产物，请勿直接编辑。源码见 src/，修改后运行 node build.mjs */

(function () {
  'use strict';

// ===========================================================================
// 10-log.js
// ===========================================================================
// ---------------------------------------------------------------------------
// log.js —— 分级日志：环形缓冲 + 订阅（供面板展示）
// 不打印任何账号信息；只记录 DOM 选择器命中与状态流转。
// ---------------------------------------------------------------------------
const Log = (function () {
  const MAX_RECORDS = 300;
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const records = [];
  const listeners = new Set();
  let minLevel = LEVELS.info;

  function timeText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function emit(level, message, detail) {
    const record = { at: Date.now(), time: timeText(), level: level, message: String(message) };
    if (detail !== undefined) record.detail = detail;
    records.push(record);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);

    if (LEVELS[level] >= minLevel) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink.call(console, '[课程伴学工具][' + record.time + '][' + level + '] ' + record.message);
    }
    for (const listener of listeners) {
      try {
        listener(record);
      } catch (e) {
        /* 面板异常不得影响主流程 */
      }
    }
    return record;
  }

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    setDebug(on) {
      minLevel = on ? LEVELS.debug : LEVELS.info;
    },
    isDebug() {
      return minLevel === LEVELS.debug;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    recent(count) {
      return records.slice(Math.max(0, records.length - (count || 50)));
    },
    all() {
      return records.slice();
    },
    clear() {
      records.length = 0;
    },
  };
})();

// ===========================================================================
// 20-config.js
// ===========================================================================
// ---------------------------------------------------------------------------
// config.js —— 默认配置与持久化（配置 + 断点；不含任何凭证）
// 优先使用油猴存储，非油猴环境下退化为 localStorage。
// ---------------------------------------------------------------------------
const Config = (function () {
  const PREFIX = 'cxNaturalWatch:';

  const DEFAULTS = {
    // ---- 播放（playbackRate 固定 1.0，代码内多处断言，不提供修改入口）----
    playbackRate: 1.0,
    autoStart: false, // 打开课程页是否自动开始

    // ---- 定位 / 超时 ----
    locateMaxAttempts: 6, // 拿不到 video 时的定位重试次数
    locateRetryDelayMs: 2500,
    settleTimeoutMs: 20000, // 视频结束后等待平台"记为完成"的上限
    advanceTimeoutMs: 15000, // 点击下一节点后等待就绪的上限

    // ---- 恢复（全部有限次，绝不无限循环）----
    maxResumeAttempts: 3, // 意外暂停后自动恢复播放的次数上限
    maxPlayReject: 3, // play() 被浏览器拒绝的提示次数上限
    pauseObserveMs: 900, // 暂停后观察窗口：给弹题 DOM 出现的时机，避免误恢复
    awaitingConfirmMaxWait: 3, // 「继续等待」次数上限
    stallTimeoutMs: 75000, // 播放进度停滞阈值（60~90s），超过判定为异常

    // ---- 看门狗（低频，仅记录，不刷新页面）----
    watchdogEnabled: true,
    watchdogIntervalMs: 15000,
    stalledWarnMs: 45000, // 播放中超过此时长无进度则记 warning

    // ---- 日志 / 面板 ----
    debugLog: false,
    panelCollapsed: false,
    panelPos: null, // { right: number, top: number }

    // ---- AI 弹题（阶段 D）----
    // 默认关闭：只有用户显式开启且检测到真实题目时才请求模型
    llmEnabled: false,
    llmMode: 'proxy', // 'proxy'（本地代理，推荐）| 'direct'（需用户自行加 @connect）
    llmProxyUrl: 'http://127.0.0.1:8787',
    llmProxyToken: '',
    llmBaseUrl: 'https://api.deepseek.com/v1',
    llmModel: 'deepseek-chat',
    llmApiKey: '', // 仅在 GM 存储可用时写入；非油猴环境拒绝保存
    llmTemperature: 0.2,
    llmTimeoutMs: 45000,
    llmMaxRetries: 2,
    // 是否允许"应用建议"时自动勾选选项（提交仍然永远需要人工点击）
    quizAutoApply: true,

    // ---- 视觉识别（阶段 D2，题目加密时使用）----
    visionEnabled: false,
    visionBridgeUrl: 'http://127.0.0.1:8788',
    visionBridgeToken: '',
    visionTimeoutMs: 130000,

    // ---- 章节测验闸门：本节视频播完后先做本节测验，再切下一节 ----
    quizGateEnabled: true,
    quizPageTimeoutMs: 20000,
  };

  function hasGM() {
    return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  }

  function readRaw(key) {
    try {
      if (hasGM()) {
        const v = GM_getValue(PREFIX + key, undefined);
        if (v === undefined) return undefined;
        return typeof v === 'string' ? JSON.parse(v) : v;
      }
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (e) {
      Log.warn('读取配置失败：' + key, e && e.message);
      return undefined;
    }
  }

  function writeRaw(key, value) {
    try {
      if (hasGM()) {
        GM_setValue(PREFIX + key, JSON.stringify(value));
      } else {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      }
      return true;
    } catch (e) {
      Log.warn('保存配置失败：' + key, e && e.message);
      return false;
    }
  }

  const cache = Object.assign({}, DEFAULTS);

  return {
    DEFAULTS: DEFAULTS,

    load() {
      for (const key of Object.keys(DEFAULTS)) {
        const stored = readRaw('cfg.' + key);
        if (stored !== undefined && stored !== null) {
          cache[key] = typeof DEFAULTS[key] === 'number' ? Number(stored) : stored;
        }
      }
      // 硬性约束：倍速永远是 1.0
      cache.playbackRate = 1.0;
      Log.setDebug(cache.debugLog === true);
      return cache;
    },

    get(key) {
      return cache[key];
    },

    set(key, value) {
      if (key === 'playbackRate') {
        Log.warn('倍速被锁定为 1.0，忽略写入');
        return false;
      }
      // 安全约束：非油猴环境下 localStorage 会被页面脚本读取，绝不能存 Key
      if (key === 'llmApiKey' && value) {
        if (!hasGM()) {
          Log.error('当前环境没有油猴隔离存储，拒绝保存 API Key（会被页面读取）。请改用本地代理模式。');
          return false;
        }
      }
      cache[key] = value;
      if (key === 'debugLog') Log.setDebug(value === true);
      return writeRaw('cfg.' + key, value);
    },

    // ---- 断点：只用于"从上次位置继续定位"，绝不用于认定平台已完成 ----
    saveCursor(cursor) {
      return writeRaw('cursor', {
        courseKey: cursor.courseKey || '',
        jobKey: cursor.jobKey || '',
        jobTitle: cursor.jobTitle || '',
        savedAt: Date.now(),
      });
    },

    readCursor() {
      return readRaw('cursor') || null;
    },

    clearCursor() {
      return writeRaw('cursor', null);
    },

    // ---- pendingConfirm：用户"跳过并记录"的任务，跨刷新保留 ----
    // 存稳定的 courseId/chapterId/type#index，不存标题。
    savePending(keys) {
      const list = Array.from(keys || []);
      return writeRaw('pendingConfirm', list.slice(0, 500));
    },

    readPending() {
      const stored = readRaw('pendingConfirm');
      if (!Array.isArray(stored)) return [];
      return stored.filter((item) => typeof item === 'string' && item);
    },

    clearPending() {
      return writeRaw('pendingConfirm', []);
    },

    // 供 UI 判断能否安全保存 API Key：
    // 只有油猴隔离存储才允许存 Key；localStorage 会暴露给页面，必须拒绝。
    hasGM() {
      return hasGM();
    },
  };
})();

// ===========================================================================
// 30-selectors.js
// ===========================================================================
// ---------------------------------------------------------------------------
// selectors.js —— 全部 DOM 选择器集中管理
//
// 组织方式：语义名 -> 候选数组。查找时按顺序尝试，第一个命中的生效。
// 所有条目均标注来源与验证状态；未经真实页面验证的条目一律标记 UNVERIFIED。
//
// 来源说明：
//   [GF572981]  = Greasy Fork 572981（MIT），任务点 aria-label 判定
//   [ZHU]       = zhu-hailin/chaoxing-ai-assistant（MIT），弹题选择器常量
//   [CL]        = chaolucky18/xuexitongScript（无许可证，仅作事实参考，不复制代码）
//   [DR]        = DaRin1403/xuexitong-autostudy（MIT），iframe 路径形态
// ---------------------------------------------------------------------------
const SEL = {
  // ===== 课程内容 iframe（顶层页面里承载卡片的 iframe）=====
  // [CL] 用 #iframe；[DR] 同
  courseFrame: ['iframe#iframe', '#iframe'],
  // 卡片容器可能在第二层 iframe 内，任务点直接挂在任一可达文档里
  maxFrameDepth: 3,

  // ===== 任务点 =====
  // [实测 2026-11-10 学习页 mooc1/mycourse/studentstudy]
  //   .ans-job       不存在
  //   .ans-attach-ct 实际容器（附加类 .videoContainer）
  //   父级链：div.ans-job-icon < div.ans-attach-ct.videoContainer < p.editor-iframe < div.ans-cc
  // .ans-job 保留用于旧版页面兼容。
  jobContainer: ['.ans-attach-ct', '.ans-job', '[data-isjob="true"]', '.ans-job-finished'],
  jobIcon: ['.ans-job-icon'],
  jobFinishedClass: 'ans-job-finished',
  // [实测] aria-label="任务点未完成" 与旧版一致，可原样使用
  iconLabelUnfinished: ['任务点未完成', '未完成'],
  iconLabelFinished: ['任务点已完成', '已完成'],
  jobInnerIframe: ['iframe'],
  // [实测] 播放器 iframe 的类名
  jobVideoFrame: '.ans-attach-online, .ans-insertvideo-online',

  // ===== 播放器 =====
  // [DR] videojs 初始化在 #video_html5_api；[CL] 同；vjs-tech 为 video.js 默认类名
  // [实测] id="video_html5_api" class="vjs-tech" 两者同时存在
  videoElement: ['#video_html5_api', 'video.vjs-tech', 'video'],

  // ===== 课程目录 =====
  // [实测] #coursetree ×1、.posCatalog_level ×9、.posCatalog_select ×40 同时存在
  catalogRoot: ['#coursetree', '.posCatalog_level'],
  // [实测] 只保留 .posCatalog_select；原先的 'li' 会误匹配外层 li，必须移除
  catalogItem: ['.posCatalog_select'],
  catalogActiveClass: 'posCatalog_active',
  catalogNameNode: ['.catalog_name', '.posCatalog_name', 'span[title]'],
  // 章（一级）与节（二级）的区分：带 firstLayer 类的是一级
  firstLayerClass: 'firstLayer',

  // ===== 目录层完成度（实测新增）=====
  // [实测] 每节文本形如 "1.1 大党之治：… 2个待完成任务点2"
  // 这是不进节就能判断完成度的最佳信号。
  catalogPendingPattern: /(\d+)\s*个待完成任务点/,
  catalogPendingWord: '待完成任务点',
  // 头部汇总，形如 "已完成任务点: 0/59"
  catalogSummaryText: /已完成任务点[:：]?\s*(\d+)\s*\/\s*(\d+)/,

  // ===== 节内任务类型标签（实测新增）=====
  // [实测] 页面标签为 "1 课程视频" / "2 章节测验"
  // 每节"N个待完成任务点"通常是 1 视频 + 1 测验，不能把测验当视频处理。
  // 注意：不要用 [class*="tab"] 这种宽泛选择器——实机验证时它误匹配到了
  // 页面里无关的隐藏文本（"请输入验证码…"），导致任务类型判断被污染。
  taskTabVideo: /课程视频|视频/,
  taskTabQuiz: /章节测验|测验|作业/,
  taskTabSelector: '.prev_white, .prev_title',

  // ===== 页面级"下一节"按钮 =====
  // [GF572981][DR] 均使用这两个
  nextSectionButton: ['#prevNextFocusNext', '.nextChapter'],
  // 结束弹窗里的"下一节"
  popContainer: ['.popDiv'],

  // ===== 弹题（阶段 D，选择器来自 zhu-hailin MIT 常量 + 通用候选）=====
  // 注意：真实弹题 DOM 尚未实机采集，以下均为候选，需要靠诊断收敛。
  quizRoot: ['.ans-videoquiz', '[data-video-quiz-root]'],
  quizSubmitButton: ['#videoquiz-submit', '[data-video-quiz-submit]'],
  quizContinueButton: ['#videoquiz-continue', '.ans-videoquiz-continue'],
  quizFeedback: [
    '[data-video-quiz-result]',
    '.videoquiz-result',
    '.videoquiz-feedback',
    '.answer-feedback',
  ],
  // 题干候选（按优先级）
  quizStem: [
    '.tkItem_title',
    'legend',
    '.question-title',
    '.quiz-title',
    '.subject-title',
    '[class*="stem"]',
    '[class*="title"]',
  ],
  // 选项容器候选
  quizOptionBox: ['li', 'label', '.option-item', '[class*="option"]', '[class*="item"]'],
  // 判分/对错提示（用于确认是否已作答成功）
  quizRight: ['.rightInfo', '[class*="right"]', '.dui', '.correct'],
  quizWrong: ['.spanNot', '.spanNotBack', '[class*="wrong"]', '.cuo'],
  // 选项字母前缀，如 "A." "B、" "C：" "D)"
  quizLetterPattern: /^([A-H])[.、．:：)）]\s*/,
  // 判断题选项词
  quizJudgeWords: /^(正确|错误|对|错|是|否|true|false|√|×)$/i,

  // ===== iframe src 类型判定 =====
  // [DR] /ananas/modules/<type>/
  jobTypePatterns: [
    { type: 'video', re: /\/ananas\/modules\/video\//i },
    { type: 'audio', re: /\/ananas\/modules\/audio\//i },
    { type: 'document', re: /\/ananas\/modules\/(doc|pdf|ppt)\//i },
    { type: 'image', re: /\/ananas\/modules\/(img|image|picture)\//i },
    { type: 'work', re: /\/ananas\/modules\/work\//i },
  ],
};

// 查找策略：对同一文档 + 候选数组，返回第一个命中的元素
function queryFirst(root, candidates) {
  if (!root || !root.querySelector) return null;
  for (const selector of candidates) {
    try {
      const found = root.querySelector(selector);
      if (found) return found;
    } catch (e) {
      /* 非法选择器不应中断流程 */
    }
  }
  return null;
}

// 返回第一个命中的选择器名，便于日志定位是哪条规则生效
function queryFirstWithSelector(root, candidates) {
  if (!root || !root.querySelector) return null;
  for (const selector of candidates) {
    try {
      const found = root.querySelector(selector);
      if (found) return { selector, element: found };
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

function queryAllAcross(root, candidates) {
  const seen = new Set();
  const out = [];
  for (const selector of candidates) {
    try {
      for (const el of root.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    } catch (e) {
      /* ignore */
    }
  }
  return out;
}

// 互斥候选专用：按顺序尝试，返回「第一个能匹配到元素的选择器」的全部结果。
// 不能像 queryAllAcross 那样合并，否则 ['.posCatalog_select', 'li'] 会把同一个
// 节点匹配两次，导致目录条目数量翻倍、索引错位。
function queryAllFirst(root, candidates) {
  if (!root || !root.querySelectorAll) return [];
  for (const selector of candidates) {
    try {
      const found = root.querySelectorAll(selector);
      if (found && found.length) return Array.prototype.slice.call(found);
    } catch (e) {
      /* ignore */
    }
  }
  return [];
}

// ===========================================================================
// 35-urls.js
// ===========================================================================
// ---------------------------------------------------------------------------
// urls.js —— 课程页面判定与身份提取（P0-1）
//
// 真实页面证据（2026-11-10 实测）：
//   课程主页 https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu
//     顶层 document.domain 被平台设为 "chaoxing.com"，
//     而 #frame_content-zj 未做同样设置 -> 访问 contentDocument 抛 SecurityError。
//     该页只有导航壳子，课程目录与任务点全在不可读的子框架里，
//     **不能**作为自动连播的运行入口。
//   学习页 https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=...&courseId=...
//     三层同源可读，是唯一可工作的入口。
//
// 本模块是唯一的 URL 判定来源，main 与 runner 都必须调用它。
// ---------------------------------------------------------------------------
const CourseUrl = (function () {
  // 可注入并可运行的真实学习页
  const STUDY_PATTERNS = [
    /\/mycourse\/studentstudy(?:[/?#]|$)/i,
    // knowledge/cards 实测是学习页的内层 iframe（顶层不会出现）；
    // 保留它是为了容错：若将来放开 @noframes 注入子框架，这里仍是合法工作面。
    /\/mooc-ans\/knowledge\/cards(?:[/?#]|$)/i,
  ];

  // 明确排除：课程主页壳子与它的子页
  const EXCLUDED_PATTERNS = [
    /\/mooc2-ans\/mycourse\/stu(?:[/?#]|$)/i,
    /\/mooc2-ans\/mycourse\/studentcourse(?:[/?#]|$)/i,
    /\/mooc2-ans\/mycourse\//i,
    /\/mooc2-ans\//i,
  ];

  function test(patterns, url) {
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(url)) return true;
    }
    return false;
  }

  function isStudyPage(url) {
    const target = String(url || '');
    if (!target) return false;
    // 先排除，再匹配：排除优先，避免未来新增模式时误中课程主页
    if (test(EXCLUDED_PATTERNS, target)) return false;
    return test(STUDY_PATTERNS, target);
  }

  function isExcluded(url) {
    return test(EXCLUDED_PATTERNS, String(url || ''));
  }

  function searchParams(url) {
    try {
      return new URL(String(url || location.href), location.href).searchParams;
    } catch (e) {
      return null;
    }
  }

  function pick(params, names) {
    if (!params) return '';
    for (let i = 0; i < names.length; i++) {
      const value = params.get(names[i]);
      if (value) return String(value);
    }
    return '';
  }

  // 课程身份：用于 pendingConfirm 的稳定标识，不用标题
  function identity(url) {
    const params = searchParams(url);
    return {
      courseId: pick(params, ['courseId', 'courseid']),
      chapterId: pick(params, ['chapterId', 'chapterid', 'knowledgeId', 'knowledgeid']),
      clazzId: pick(params, ['clazzid', 'clazzId']),
    };
  }

  // 稳定 key：courseId/chapterId/type#index
  function jobKey(job, url) {
    const id = identity(url);
    if (!job) return '';
    const type = job.type || 'unknown';
    const index = job.indexInDoc === undefined ? '' : job.indexInDoc;
    return [id.courseId || '?', id.chapterId || '?', type, '#' + index].join('/');
  }

  // 页面类型描述，用于诊断
  function describe(url) {
    const target = String(url || location.href);
    if (isExcluded(target)) return 'excluded-course-home';
    if (isStudyPage(target)) return 'study-page';
    return 'other';
  }

  return {
    isStudyPage,
    isExcluded,
    identity,
    jobKey,
    describe,
    STUDY_PATTERNS,
    EXCLUDED_PATTERNS,
  };
})();

// ===========================================================================
// 40-dom.js
// ===========================================================================
// ---------------------------------------------------------------------------
// dom.js —— 跨 iframe 的文档收集与安全操作
// 学习通课程页典型嵌套：顶层 -> #iframe(卡片列表) -> 任务点 iframe(播放器)
// 三层通常同源；跨域时一律跳过，不做任何绕过尝试。
// ---------------------------------------------------------------------------
const Dom = (function () {
  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      if (!view) return false;
      const style = view.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 用真实 MouseEvent 序列点击，尽量贴近用户操作（不直接改 DOM 状态）
  // 注意：对 input/button/label/a 这类表单控件只调用 click()。
  // 若既 dispatch click 又调用 click()，checkbox 会被切换两次（等于没勾上）。
  function click(el) {
    if (!el) return false;
    try {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const tag = String(el.tagName || '').toLowerCase();

      if (['input', 'button', 'label', 'a', 'select'].indexOf(tag) !== -1 && typeof el.click === 'function') {
        el.click();
        return true;
      }

      let rect = { left: 0, top: 0, width: 0, height: 0 };
      try {
        rect = el.getBoundingClientRect();
      } catch (e) {
        /* ignore */
      }
      const base = {
        bubbles: true,
        cancelable: true,
        view: view,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      };
      el.dispatchEvent(new view.MouseEvent('mousedown', base));
      el.dispatchEvent(new view.MouseEvent('mouseup', base));
      el.dispatchEvent(new view.MouseEvent('click', base));
      return true;
    } catch (e) {
      Log.warn('点击元素失败', e && e.message);
      return false;
    }
  }

  // 广度优先收集所有同源可达文档
  // 返回 { documents: [{ doc, win, depth, frameEl }], inaccessible: [{ frameEl, src, depth, reason }] }
  // inaccessible 必须被上层显式处理：不能静默丢掉，否则"找不到任务点"无从解释。
  function collectDocuments(rootWindow, maxDepth) {
    const out = [];
    const inaccessible = [];
    const seenDocs = new Set();
    const queue = [{ win: rootWindow, depth: 0, frameEl: null }];

    while (queue.length) {
      const item = queue.shift();
      let doc = null;
      try {
        doc = item.win && item.win.document;
      } catch (e) {
        if (item.frameEl) {
          inaccessible.push({
            frameEl: item.frameEl,
            src: item.frameEl.getAttribute ? item.frameEl.getAttribute('src') || '' : '',
            depth: item.depth,
            reason: 'document-access-denied',
          });
        }
        continue;
      }
      if (!doc || seenDocs.has(doc)) continue;
      seenDocs.add(doc);
      out.push({ doc: doc, win: item.win, depth: item.depth, frameEl: item.frameEl });

      if (item.depth >= maxDepth) continue;

      for (const frame of toArray(doc.querySelectorAll('iframe'))) {
        let childWin = null;
        try {
          childWin = frame.contentWindow;
        } catch (e) {
          childWin = null;
        }
        if (!childWin) {
          inaccessible.push({
            frameEl: frame,
            src: frame.getAttribute('src') || '',
            depth: item.depth + 1,
            reason: 'no-content-window',
          });
          continue;
        }
        let childDoc = null;
        try {
          childDoc = childWin.document;
        } catch (e) {
          inaccessible.push({
            frameEl: frame,
            src: frame.getAttribute('src') || '',
            depth: item.depth + 1,
            reason: 'cross-origin:' + ((e && e.name) || 'SecurityError'),
          });
          continue;
        }
        if (!childDoc) {
          inaccessible.push({
            frameEl: frame,
            src: frame.getAttribute('src') || '',
            depth: item.depth + 1,
            reason: 'empty-document',
          });
          continue;
        }
        queue.push({ win: childWin, depth: item.depth + 1, frameEl: frame });
      }
    }
    return { documents: out, inaccessible: inaccessible };
  }

  function parseFrameData(frameEl) {
    if (!frameEl) return null;
    const raw = frameEl.getAttribute('data');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // 解析 iframe 的绝对地址（相对地址按所属文档补全）
  function frameUrl(frameEl) {
    if (!frameEl) return '';
    const src = frameEl.getAttribute('src') || '';
    if (!src) return '';
    try {
      const doc = frameEl.ownerDocument;
      const base = (doc && doc.baseURI) || location.href;
      return new URL(src, base).href;
    } catch (e) {
      return src;
    }
  }

  function textOf(el, limit) {
    if (!el) return '';
    let text = '';
    try {
      text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      text = '';
    }
    const max = limit || 80;
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function stopObserver(observer) {
    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function waitTimeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    toArray,
    isVisible,
    click,
    collectDocuments,
    parseFrameData,
    frameUrl,
    textOf,
    stopObserver,
    waitTimeout,
  };
})();

// ===========================================================================
// 50-course-tree.js
// ===========================================================================
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
          state: stateInfo.state,
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
    const text = Dom.textOf(itemEl, 200);
    if (!text) return null;
    const match = text.match(SEL.catalogPendingPattern);
    if (!match) return null;
    const value = Number(match[1]);
    return isFinite(value) ? value : null;
  }

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

    const next = catalog.items[activeIndex + 1];
    if (!next) return { ok: false, reason: 'last-item' };

    const target = queryFirst(next, SEL.catalogNameNode) || next;
    const title = Dom.textOf(next, 40);
    if (!Dom.click(target)) return { ok: false, reason: 'click-failed' };
    return { ok: true, by: 'catalog:' + catalog.rootSelector, title: title, index: activeIndex + 1 };
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
    readCatalogPending,
    readCatalogSummary,
    readTaskTabs,
    clickNextCatalogItem,
    clickNextSectionButton,
    waitForJobsChange,
  };
})();

// ===========================================================================
// 60-video.js
// ===========================================================================
// ---------------------------------------------------------------------------
// video.js —— 播放器定位后的绑定、播放与状态读取
// 硬性约束：播放速率恒为 1.0；不做 seek；不静音；不覆盖平台自身的 onXXX。
// ---------------------------------------------------------------------------
const VideoCtl = (function () {
  let boundVideo = null;
  let boundHandlers = null;
  let lastTickAt = 0;

  function atEnd(video) {
    if (!video) return false;
    try {
      if (video.ended) return true;
      const duration = Number(video.duration);
      const current = Number(video.currentTime);
      if (!isFinite(duration) || duration <= 0) return false;
      return current >= duration - 0.5;
    } catch (e) {
      return false;
    }
  }

  function info(video) {
    const target = video || boundVideo;
    if (!target) return null;
    try {
      return {
        currentTime: Number(target.currentTime) || 0,
        duration: Number(target.duration) || 0,
        paused: !!target.paused,
        ended: !!target.ended,
        readyState: Number(target.readyState) || 0,
        // 停滞判定的关键信号：区分"缓冲中"与"真停滞"
        networkState: Number(target.networkState) || 0,
        playbackRate: Number(target.playbackRate) || 1,
        muted: !!target.muted,
      };
    } catch (e) {
      return null;
    }
  }

  function detach() {
    if (!boundVideo || !boundHandlers) {
      boundVideo = null;
      boundHandlers = null;
      return;
    }
    const v = boundVideo;
    const h = boundHandlers;
    // 用同一份引用解绑，避免匿名函数导致的监听器泄漏
    try {
      v.removeEventListener('ended', h.ended);
      v.removeEventListener('pause', h.pause);
      v.removeEventListener('playing', h.playing);
      v.removeEventListener('error', h.error);
      v.removeEventListener('loadedmetadata', h.loadedmetadata);
      v.removeEventListener('timeupdate', h.timeupdate);
    } catch (e) {
      /* ignore */
    }
    boundVideo = null;
    boundHandlers = null;
  }

  function attach(video, callbacks) {
    if (!video || !callbacks) return false;
    if (boundVideo === video && boundHandlers) return true;

    detach();
    boundVideo = video;
    lastTickAt = 0;

    let endedFired = false;

    boundHandlers = {
      ended: function () {
        if (endedFired) return;
        endedFired = true;
        if (callbacks.onEnded) callbacks.onEnded(video);
      },
      pause: function () {
        if (video.ended) return;
        if (callbacks.onPause) callbacks.onPause(video);
      },
      playing: function () {
        endedFired = false;
        if (callbacks.onPlaying) callbacks.onPlaying(video);
      },
      error: function () {
        if (callbacks.onError) callbacks.onError(video, video.error);
      },
      loadedmetadata: function () {
        if (callbacks.onLoaded) callbacks.onLoaded(video);
      },
      timeupdate: function () {
        // timeupdate 约 4Hz，节流到 2s，仅用于进度显示与结束兜底
        const now = Date.now();
        if (now - lastTickAt < 2000) return;
        lastTickAt = now;
        if (atEnd(video)) {
          if (!endedFired) {
            endedFired = true;
            if (callbacks.onEnded) callbacks.onEnded(video);
          }
          return;
        }
        if (callbacks.onTick) callbacks.onTick(video);
      },
    };

    video.addEventListener('ended', boundHandlers.ended);
    video.addEventListener('pause', boundHandlers.pause);
    video.addEventListener('playing', boundHandlers.playing);
    video.addEventListener('error', boundHandlers.error);
    video.addEventListener('loadedmetadata', boundHandlers.loadedmetadata);
    video.addEventListener('timeupdate', boundHandlers.timeupdate);
    return true;
  }

  // 播放：先锁定 1.0 倍速，再调用 play()。被浏览器拒绝时如实上报，不做静音绕过。
  async function play(video) {
    const target = video || boundVideo;
    if (!target) return { ok: false, reason: 'no-video' };

    try {
      if (Number(target.playbackRate) !== 1) {
        target.playbackRate = 1; // 仅纠正为自然速度
      }
    } catch (e) {
      /* 部分播放器包装层会抛错，忽略 */
    }

    try {
      // 已播完的元素先归零会制造成"重播"，这里只在确实未开始时调用
      await target.play();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: (error && error.name) || 'play-rejected',
        message: (error && error.message) || '',
      };
    }
  }

  function pause(video) {
    const target = video || boundVideo;
    if (!target) return false;
    try {
      target.pause();
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    attach,
    detach,
    play,
    pause,
    info,
    atEnd,
    current() {
      return boundVideo;
    },
  };
})();

// ===========================================================================
// 65-pause.js
// ===========================================================================
// ---------------------------------------------------------------------------
// pause.js —— 暂停分诊（P0-2）
//
// 设计原则：
//   1. 只读。读 visibilityState / hasFocus / readyState / networkState，
//      不拦截任何事件，不写 document.hidden 或 visibilityState。
//   2. 优先级分诊，命中即返回，不做"统一当意外暂停"。
//   3. 后台暂停与用户主动暂停一律不自动恢复（B 策略）。
//   4. 无法可靠分类时返回 unknown，由 runner 转人工确认，绝不盲目 play()。
//
// 真实页面证据（2026-11-10）：视频在 iframe 内，document 需取 video.ownerDocument。
// ---------------------------------------------------------------------------
const PauseClassifier = (function () {
  const NETWORK_LOADING = 2;
  const HAVE_FUTURE_DATA = 3;

  const REASONS = {
    ended: '视频正常结束',
    quiz: '检测到交互题目',
    user: '用户主动暂停',
    background: '页面切换到后台或窗口失焦',
    loading: '视频缓冲或加载中',
    unexpected: '无法解释的意外暂停',
    unknown: '无法可靠分类',
  };

  function safeGet(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function readSignals(video) {
    let doc = null;
    try {
      doc = (video && video.ownerDocument) || document;
    } catch (e) {
      doc = null;
    }
    if (!doc) doc = document;

    return {
      // 只读字段
      visibilityState: safeGet(function () {
        return String(doc.visibilityState || 'unknown');
      }, 'unknown'),
      hidden: safeGet(function () {
        return !!doc.hidden;
      }, null),
      hasFocus: safeGet(function () {
        return typeof doc.hasFocus === 'function' ? !!doc.hasFocus() : null;
      }, null),
      readyState: safeGet(function () {
        return Number(video.readyState) || 0;
      }, 0),
      networkState: safeGet(function () {
        return Number(video.networkState) || 0;
      }, 0),
      ended: safeGet(function () {
        return !!video.ended;
      }, false),
      paused: safeGet(function () {
        return !!video.paused;
      }, true),
      currentTime: safeGet(function () {
        return Number(video.currentTime) || 0;
      }, 0),
      duration: safeGet(function () {
        return Number(video.duration) || 0;
      }, 0),
    };
  }

  // 在可达文档里查找弹题容器（只读）
  function detectQuizRoot() {
    try {
      const collected = Dom.collectDocuments(window, SEL.maxFrameDepth);
      const docs = (collected && collected.documents) || [];
      for (const entry of docs) {
        for (const selector of SEL.quizRoot) {
          try {
            const found = entry.doc.querySelector(selector);
            if (found && Dom.isVisible(found)) return true;
          } catch (e) {
            /* ignore */
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  /**
   * @param {object} input
   *   video           当前 video
   *   now             Date.now()
   *   userIntentAt    最近一次用户输入时间戳
   *   lastBlurAt      最近一次 blur 时间戳
   *   lastStalledAt   最近一次 stalled/waiting 时间戳
   *   quizRootFound   是否已检出弹题容器（调用方可在观察窗口后重新计算）
   *   userIntentWindowMs / backgroundWindowMs / loadingWindowMs 可配
   */
  function classify(input) {
    const options = (input && input.options) || {};
    const userIntentWindowMs = Number(options.userIntentWindowMs) || 3000;
    const backgroundWindowMs = Number(options.backgroundWindowMs) || 60000;
    const loadingWindowMs = Number(options.loadingWindowMs) || 3000;

    const video = input && input.video;
    const signals = readSignals(video);
    const now = Number(input && input.now) || Date.now();
    const base = { signals: signals, now: now };

    // 1) 正常结束
    if (signals.ended) {
      return Object.assign({ reason: 'ended', label: REASONS.ended, autoResume: false }, base);
    }

    // 2) 交互题目（调用方已给结论或此处实时检测）
    const quizRootFound = input && input.quizRootFound !== undefined ? input.quizRootFound : detectQuizRoot();
    if (quizRootFound) {
      return Object.assign({ reason: 'quiz', label: REASONS.quiz, autoResume: false }, base);
    }

    // 3) 用户主动暂停
    const userIntentAt = Number(input && input.userIntentAt) || 0;
    if (userIntentAt && now - userIntentAt <= userIntentWindowMs) {
      return Object.assign({ reason: 'user', label: REASONS.user, autoResume: false }, base);
    }

    // 4) 后台 / 失焦
    const hidden = signals.visibilityState === 'hidden' || signals.hidden === true;
    const blurredRecently =
      signals.hasFocus === false &&
      Number(input && input.lastBlurAt) > 0 &&
      now - Number(input.lastBlurAt) <= backgroundWindowMs;
    if (hidden || blurredRecently) {
      return Object.assign({ reason: 'background', label: REASONS.background, autoResume: false }, base);
    }

    // 5) 缓冲 / 加载
    const stalledRecently =
      Number(input && input.lastStalledAt) > 0 && now - Number(input.lastStalledAt) <= loadingWindowMs;
    if (
      signals.readyState < HAVE_FUTURE_DATA ||
      signals.networkState === NETWORK_LOADING ||
      stalledRecently
    ) {
      return Object.assign({ reason: 'loading', label: REASONS.loading, autoResume: false }, base);
    }

    // 6) 可解释的意外暂停
    return Object.assign({ reason: 'unexpected', label: REASONS.unexpected, autoResume: true }, base);
  }

  return {
    classify,
    readSignals,
    detectQuizRoot,
    REASONS,
  };
})();

// ===========================================================================
// 66-quiz-model.js
// ===========================================================================
// ---------------------------------------------------------------------------
// quiz-model.js —— 弹题 DOM 解析与模型输出校验（纯逻辑，可单测）
//
// 设计原则：
//   1. 只读解析，不做任何点击。
//   2. 题型优先由 input 类型判断（radio/checkbox），比文字猜测可靠。
//   3. 模型输出必须与真实选项集合对齐，任何越界选项一律拒绝。
//   4. 无法可靠识别时返回 ok:false，由上层转人工，不猜测。
//
// 真实弹题 DOM 尚未实机采集（阶段 C 只验证了视频连播），
// 因此所有选择器都是多候选，解析结果必须经过 validateQuestion 才可用于提问。
// ---------------------------------------------------------------------------
const QuizModel = (function () {
  const TYPES = { single: 'single', multiple: 'multiple', judge: 'judge', unknown: 'unknown' };

  const TYPE_LABELS = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    unknown: '未知题型',
  };

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function textOf(el) {
    try {
      return normalize(el && el.textContent);
    } catch (e) {
      return '';
    }
  }

  // 稳定 hash：题干 + 选项文本，用于题目去重与请求去重
  function hash(text) {
    let h = 5381;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
      h = ((h << 5) + h + source.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function findRoot(doc) {
    for (const selector of SEL.quizRoot) {
      try {
        const el = doc.querySelector(selector);
        if (el && Dom.isVisible(el)) return el;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  // 选项容器：优先"包含 input 的最接近容器"，避免把无关 li 算进来
  function findOptionItems(root) {
    const items = [];
    const seen = new Set();

    let inputs = [];
    try {
      inputs = Dom.toArray(root.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    } catch (e) {
      inputs = [];
    }

    if (inputs.length) {
      for (const input of inputs) {
        let box = null;
        try {
          box = input.closest('label, li, .option, .option-item, [class*="option"], [class*="item"]');
        } catch (e) {
          box = null;
        }
        if (!box) box = input.parentElement;
        if (!box || seen.has(box)) continue;
        seen.add(box);
        items.push({ box: box, input: input });
      }
      if (items.length) return items;
    }

    for (const selector of SEL.quizOptionBox) {
      let nodes = [];
      try {
        nodes = Dom.toArray(root.querySelectorAll(selector));
      } catch (e) {
        nodes = [];
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        // 过滤掉明显是容器而非选项的节点
        if (node.querySelector && node.querySelector('li, label')) continue;
        seen.add(node);
        items.push({ box: node, input: null });
      }
      if (items.length) break;
    }
    return items;
  }

  function letterOf(item, index) {
    let text = '';
    try {
      text = textOf(item.box);
    } catch (e) {
      text = '';
    }
    const match = text.match(SEL.quizLetterPattern);
    if (match) return match[1];

    if (item.input) {
      const value = String(item.input.value || '').trim();
      if (/^[A-H]$/i.test(value)) return value.toUpperCase();
    }
    return String.fromCharCode(65 + index);
  }

  function optionText(item, letter) {
    let text = textOf(item.box);
    if (!text) return '';
    // 去掉 "A." 之类前缀与结尾的占位
    text = text.replace(SEL.quizLetterPattern, '');
    return text.slice(0, 200);
  }

  function detectType(root, items) {
    let hasCheckbox = false;
    let hasRadio = false;
    for (const item of items) {
      if (!item.input) continue;
      const type = String(item.input.type || '').toLowerCase();
      if (type === 'checkbox') hasCheckbox = true;
      if (type === 'radio') hasRadio = true;
    }
    if (hasCheckbox) return TYPES.multiple;
    if (hasRadio) {
      // 判断题：两个选项且文本是 正确/错误 之类
      const texts = items.map(function (item) {
        return optionText(item).replace(SEL.quizLetterPattern, '').trim();
      });
      if (texts.length === 2 && texts.every(function (t) { return SEL.quizJudgeWords.test(t); })) {
        return TYPES.judge;
      }
      return TYPES.single;
    }
    return TYPES.unknown;
  }

  function findStem(root, items) {
    for (const selector of SEL.quizStem) {
      let el = null;
      try {
        el = root.querySelector(selector);
      } catch (e) {
        continue;
      }
      if (!el) continue;
      // 题干不能是选项本身
      let isOption = false;
      for (const item of items) {
        try {
          if (item.box === el || item.box.contains(el)) {
            isOption = true;
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (isOption) continue;
      const text = textOf(el);
      if (text && text.length >= 4) return text.slice(0, 500);
    }

    // 兜底：容器文本去掉选项文本
    let containerText = textOf(root);
    for (const item of items) {
      containerText = containerText.replace(textOf(item.box), ' ');
    }
    containerText = normalize(containerText);
    return containerText ? containerText.slice(0, 500) : '';
  }

  /**
   * 解析当前弹题。
   * @returns {{ok:boolean, reason:string, root:Element|null, type:string, stem:string,
   *            options:Array<{letter:string,text:string,input:Element|null,box:Element}>,
   *            hash:string}}
   */
  function parse(doc) {
    const root = findRoot(doc || document);
    if (!root) {
      return { ok: false, reason: 'no-quiz-root', root: null, type: TYPES.unknown, stem: '', options: [], hash: '' };
    }

    const items = findOptionItems(root);
    if (!items.length) {
      return { ok: false, reason: 'no-options', root: root, type: TYPES.unknown, stem: '', options: [], hash: '' };
    }

    const options = [];
    const usedLetters = new Set();
    for (let i = 0; i < items.length; i++) {
      let letter = letterOf(items[i], i);
      // 字母冲突时按序回退，保证唯一
      if (usedLetters.has(letter)) {
        letter = String.fromCharCode(65 + i);
      }
      usedLetters.add(letter);
      options.push({
        letter: letter,
        text: optionText(items[i], letter),
        input: items[i].input,
        box: items[i].box,
      });
    }

    const type = detectType(root, items);
    const stem = findStem(root, items);
    const hashInput = stem + '|' + options.map(function (o) { return o.letter + ':' + o.text; }).join('|');

    const result = {
      ok: false,
      reason: '',
      root: root,
      type: type,
      stem: stem,
      options: options,
      hash: hash(hashInput),
    };

    if (type === TYPES.unknown) {
      result.reason = 'unknown-type';
      return result;
    }
    if (!stem || stem.length < 4) {
      result.reason = 'no-stem';
      return result;
    }
    if (options.length < 2) {
      result.reason = 'too-few-options';
      return result;
    }
    if (options.filter(function (o) { return o.text; }).length < 2) {
      result.reason = 'empty-option-text';
      return result;
    }

    result.ok = true;
    return result;
  }

  // 选项是否已被勾选（用于"应用建议"后自检）
  function isChecked(option) {
    if (!option || !option.input) return null;
    try {
      return !!option.input.checked;
    } catch (e) {
      return null;
    }
  }

  /**
   * 校验模型输出与真实选项的对齐关系。
   * 任何越界字母、类型冲突都会被拒绝，不做"尽量猜"。
   * @param {object} question parse() 的结果
   * @param {any} raw 模型返回的解析后对象
   */
  function validateAnswer(question, raw) {
    const errors = [];
    let letters = [];
    let reason = '';
    let uncertain = true;
    let confidence = 0;

    if (!question || !question.ok) errors.push('题目未成功解析');

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('模型输出不是对象');
    } else {
      if (Array.isArray(raw.answer)) {
        letters = raw.answer.map(function (item) { return String(item).trim().toUpperCase(); });
      } else if (typeof raw.answer === 'string') {
        letters = raw.answer.split(/[,，、\s]+/).map(function (item) { return item.trim().toUpperCase(); });
      } else {
        errors.push('answer 字段缺失或类型错误');
      }

      reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '';
      uncertain = raw.uncertain === true;

      const parsedConfidence = Number(raw.confidence);
      confidence = isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : 0;
    }

    // 只接受单个大写字母 A-H。
    // 注意：不能静默丢弃非法项——模型给了 "Z" 或 "AB" 时必须报错，
    // 否则上层会误以为答案合法而展示一个被悄悄改过的结果。
    const malformed = letters.filter(function (item) {
      return !/^[A-H]$/.test(item);
    });
    if (malformed.length) errors.push('非法选项格式：' + malformed.join(','));
    letters = letters.filter(function (item) {
      return /^[A-H]$/.test(item);
    });

    const valid = new Set((question && question.options ? question.options : []).map(function (o) { return o.letter; }));
    const invalid = letters.filter(function (item) { return !valid.has(item); });
    if (invalid.length) errors.push('选项不存在：' + invalid.join(','));
    letters = letters.filter(function (item) { return valid.has(item); });

    // 去重
    letters = Array.from(new Set(letters));

    if (question && (question.type === TYPES.single || question.type === TYPES.judge)) {
      if (letters.length > 1) {
        errors.push('单选题返回了多个答案');
        letters = letters.slice(0, 1);
      }
    }
    if (letters.length === 0) errors.push('答案为空');

    // 多选题若模型给了 confidence 很低，标记为不确定（仍需人工判断）
    if (uncertain && confidence > 0.8) confidence = 0.8;

    return {
      ok: errors.length === 0,
      letters: letters,
      reason: reason,
      uncertain: uncertain,
      confidence: confidence,
      errors: errors,
    };
  }

  // 给模型看的选项列表（去掉 DOM 细节，只保留字母与文本）
  function toPromptPayload(question) {
    return {
      stem: question.stem,
      typeLabel: TYPE_LABELS[question.type] || '未知题型',
      options: question.options.map(function (option) {
        return { letter: option.letter, text: option.text };
      }),
    };
  }

  return {
    TYPES,
    TYPE_LABELS,
    parse,
    validateAnswer,
    toPromptPayload,
    isChecked,
    hash,
    normalize,
    findRoot,
  };
})();

// ===========================================================================
// 67-llm.js
// ===========================================================================
// ---------------------------------------------------------------------------
// llm.js —— OpenAI 兼容模型客户端（阶段 D）
//
// 硬性约束（与阶段 B v2 §7 一致）：
//   R1 所有外部 HTTP 只走 GM_xmlhttpRequest，**不用页面 fetch**
//      （https 页面 fetch 到 127.0.0.1 会触发 PNA 预检，且受 CORS/混合内容限制）
//   R2 不使用 @connect *
//   R3 默认本地代理 http://127.0.0.1:8787
//   R4 直连模式需用户自行在脚本头追加 @connect <域名>
//   R5 不申请额外 GM 权限
//
// 安全：
//   - API Key 只进 GM 隔离存储，非油猴环境拒绝保存（Config.set 已强制）
//   - 模型输出必须严格 JSON，绝不 eval / new Function / 执行返回的代码
//   - 并发锁 + 题目 hash 缓存 + 有限重试，杜绝无限消耗
// ---------------------------------------------------------------------------
const Llm = (function () {
  const STATS = {
    requests: 0,
    successes: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    lastError: '',
    lastAt: 0,
  };

  let busy = false;
  let inflight = null;
  const cache = new Map(); // hash -> { ok, payload, at }

  const SYSTEM_PROMPT = [
    '你是一个课程测验辅助器。只输出一个 JSON 对象，不要输出任何解释性文字或 Markdown 代码块。',
    'JSON 结构必须是：{"answer":["A"],"reason":"简要理由","confidence":0.0,"uncertain":false}',
    '规则：',
    '1. answer 只能是给定选项字母组成的数组，绝不能出现给定选项之外的字母。',
    '2. 单选题与判断题必须且只能给 1 个字母。',
    '3. 多选题给 1 个或多个字母。',
    '4. confidence 是 0 到 1 的数字，表示你对答案的把握。',
    '5. 若题目信息不足或你不确定，把 uncertain 设为 true，并在 reason 里说明缺什么。',
    '6. 不要编造选项，不要输出题目以外的内容。',
  ].join('\n');

  function stats() {
    return Object.assign({}, STATS);
  }

  function isBusy() {
    return busy;
  }

  function readConfig() {
    return {
      enabled: Config.get('llmEnabled') === true,
      mode: Config.get('llmMode') === 'direct' ? 'direct' : 'proxy',
      proxyUrl: String(Config.get('llmProxyUrl') || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
      proxyToken: String(Config.get('llmProxyToken') || ''),
      baseUrl: String(Config.get('llmBaseUrl') || '').replace(/\/+$/, ''),
      model: String(Config.get('llmModel') || ''),
      apiKey: String(Config.get('llmApiKey') || ''),
      temperature: Number(Config.get('llmTemperature')),
      timeoutMs: Number(Config.get('llmTimeoutMs')) || 45000,
      maxRetries: Number(Config.get('llmMaxRetries')),
    };
  }

  // 唯一的网络出口。没有 GM_xmlhttpRequest 时直接失败，绝不回退到页面 fetch。
  function gmRequest(options) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用：请用 Tampermonkey 安装本脚本，页面控制台注入无法发请求'));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: options.method || 'POST',
          url: options.url,
          headers: options.headers || {},
          data: options.data,
          timeout: options.timeout || 45000,
          onload: function (res) {
            resolve({ status: res.status, text: String(res.responseText || '') });
          },
          onerror: function () {
            reject(new Error('网络错误'));
          },
          ontimeout: function () {
            reject(new Error('请求超时'));
          },
          onabort: function () {
            reject(new Error('请求已取消'));
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // 严格提取 JSON：只接受"{...}"结构，不执行任何表达式
  function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('模型返回为空');

    // 去掉 ```json ... ``` 包裹
    let body = raw;
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) body = fence[1].trim();

    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('模型返回不含 JSON 对象');
    }
    const slice = body.slice(start, end + 1);
    if (slice.length > 4000) throw new Error('模型返回 JSON 过大，已拒绝');

    const parsed = JSON.parse(slice);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模型返回的 JSON 不是对象');
    }
    return parsed;
  }

  function buildMessages(payload) {
    const userContent = [
      '题型：' + payload.typeLabel,
      '题干：' + payload.stem,
      '选项：',
    ]
      .concat(
        payload.options.map(function (option) {
          return option.letter + '. ' + option.text;
        })
      )
      .join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];
  }

  async function callOnce(cfg, messages) {
    const isProxy = cfg.mode === 'proxy';
    const url = isProxy ? cfg.proxyUrl + '/ask' : cfg.baseUrl + '/chat/completions';

    if (!isProxy && !cfg.baseUrl) throw new Error('未配置 Base URL');
    if (!isProxy && !cfg.apiKey) throw new Error('未配置 API Key');

    const body = isProxy
      ? JSON.stringify({
          token: cfg.proxyToken,
          model: cfg.model || undefined,
          temperature: cfg.temperature,
          messages: messages,
        })
      : JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          temperature: cfg.temperature,
          messages: messages,
          response_format: { type: 'json_object' },
        });

    const headers = { 'Content-Type': 'application/json' };
    if (!isProxy) headers.Authorization = 'Bearer ' + cfg.apiKey;

    const response = await gmRequest({
      method: 'POST',
      url: url,
      headers: headers,
      data: body,
      timeout: cfg.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
      const short = response.text.slice(0, 200);
      throw new Error('HTTP ' + response.status + '：' + short);
    }

    let envelope = null;
    try {
      envelope = JSON.parse(response.text);
    } catch (e) {
      throw new Error('响应不是合法 JSON');
    }

    // 代理模式：{ content, usage }；直连模式：OpenAI 标准结构
    let content = '';
    let usage = null;
    if (envelope && typeof envelope.content === 'string') {
      content = envelope.content;
      usage = envelope.usage || null;
    } else if (envelope && envelope.choices && envelope.choices[0] && envelope.choices[0].message) {
      content = String(envelope.choices[0].message.content || '');
      usage = envelope.usage || null;
    } else if (envelope && typeof envelope.error === 'string') {
      throw new Error('模型返回错误：' + envelope.error.slice(0, 160));
    } else {
      throw new Error('响应结构无法识别');
    }

    return { content: content, usage: usage };
  }

  /**
   * 请求一次答案建议。
   * @param {object} question QuizModel.parse() 的成功结果
   * @returns {Promise<{ok:boolean, payload:object|null, error:string, cached:boolean}>}
   */
  async function ask(question) {
    const cfg = readConfig();

    if (!cfg.enabled) return { ok: false, payload: null, error: 'AI 未开启', cached: false };

    if (question && question.hash && cache.has(question.hash)) {
      const hit = cache.get(question.hash);
      Log.debug('命中题目缓存：' + question.hash);
      return { ok: true, payload: hit.payload, error: '', cached: true };
    }

    // 并发锁：同一时刻只允许一个模型请求
    if (busy) return { ok: false, payload: null, error: '上一个请求仍在进行', cached: false };
    busy = true;

    const payload = QuizModel.toPromptPayload(question);
    const messages = buildMessages(payload);
    const attempts = Math.max(0, Math.min(5, isFinite(cfg.maxRetries) ? cfg.maxRetries : 2));

    let lastError = '';
    inflight = { startedAt: Date.now(), hash: question.hash };

    try {
      for (let i = 0; i <= attempts; i++) {
        STATS.requests++;
        STATS.lastAt = Date.now();
        try {
          const result = await callOnce(cfg, messages);

          if (result.usage) {
            STATS.promptTokens += Number(result.usage.prompt_tokens) || 0;
            STATS.completionTokens += Number(result.usage.completion_tokens) || 0;
          }

          const parsed = extractJson(result.content);
          const validated = QuizModel.validateAnswer(question, parsed);

          if (!validated.ok) {
            lastError = '答案校验失败：' + validated.errors.join('；');
            Log.warn(lastError);
            // 校验失败不重试：重试同样内容大概率仍不合法，且会浪费 token
            STATS.failures++;
            STATS.lastError = lastError;
            return { ok: false, payload: null, error: lastError, cached: false };
          }

          const finalPayload = {
            letters: validated.letters,
            reason: validated.reason,
            confidence: validated.confidence,
            uncertain: validated.uncertain,
            type: question.type,
            at: Date.now(),
          };

          cache.set(question.hash, { ok: true, payload: finalPayload, at: Date.now() });
          if (cache.size > 100) cache.delete(cache.keys().next().value);

          STATS.successes++;
          return { ok: true, payload: finalPayload, error: '', cached: false };
        } catch (error) {
          lastError = (error && error.message) || '未知错误';
          STATS.failures++;
          STATS.lastError = lastError;
          const retriable = i < attempts && !/未配置|不可用|校验失败/.test(lastError);
          Log.warn('模型请求失败（第 ' + (i + 1) + '/' + (attempts + 1) + ' 次）：' + lastError);
          if (!retriable) break;
          await Dom.waitTimeout(800 + i * 600);
        }
      }

      // 失败结果也缓存，避免同一题反复烧 token
      cache.set(question.hash, { ok: false, payload: null, at: Date.now(), error: lastError });
      return { ok: false, payload: null, error: lastError || '请求失败', cached: false };
    } finally {
      busy = false;
      inflight = null;
    }
  }

  function clearCache() {
    cache.clear();
  }

  function resetStats() {
    STATS.requests = 0;
    STATS.successes = 0;
    STATS.failures = 0;
    STATS.promptTokens = 0;
    STATS.completionTokens = 0;
    STATS.lastError = '';
  }

  return {
    ask,
    stats,
    isBusy,
    clearCache,
    resetStats,
    readConfig,
    extractJson, // 暴露给单测
  };
})();

// ===========================================================================
// 70-state.js
// ===========================================================================
// ---------------------------------------------------------------------------
// state.js —— 纯状态机（不依赖 DOM，可单元测试）
// 非法转移一律被拒绝并记录，不静默吞掉。
//
// 关键约束（来自 P0-3/P0-4）：
//   - completed 只能由 runner 在 verdict === 'complete' 时进入
//   - settling 超时只能进入 awaitingConfirm，绝不能直接 advancing
//   - awaitingConfirm 是可恢复异常态，不是成功态
// ---------------------------------------------------------------------------
const StateMachine = (function () {
  const TRANSITIONS = {
    idle: ['locating', 'stopped'],
    locating: ['playing', 'settling', 'advancing', 'blocked', 'needsReview', 'paused', 'stopped', 'awaitingConfirm'],
    playing: ['settling', 'paused', 'blocked', 'stopped', 'locating', 'quizWait', 'needsReview'],
    settling: ['advancing', 'awaitingConfirm', 'blocked', 'paused', 'stopped'],
    awaitingConfirm: ['advancing', 'settling', 'locating', 'blocked', 'paused', 'stopped', 'needsReview'],
    // advancing 允许 quizWait：连播推进途中遇到本节未完成的章节测验，
    // 需要停在测验上做完再继续（见 80-runner 的 processPendingQuiz）
    advancing: [
      'locating',
      'playing',
      'blocked',
      'needsReview',
      'paused',
      'stopped',
      'awaitingConfirm',
      'completed',
      'quizWait',
    ],
    quizWait: ['playing', 'paused', 'blocked', 'stopped', 'advancing', 'locating', 'awaitingConfirm'],
    paused: ['locating', 'stopped', 'blocked'],
    blocked: ['locating', 'paused', 'stopped'],
    needsReview: ['locating', 'paused', 'stopped'],
    completed: ['locating', 'stopped'],
    stopped: ['locating'],
  };

  const LABELS = {
    idle: '未启动',
    locating: '定位任务点',
    playing: '播放中',
    settling: '等待平台记录完成',
    awaitingConfirm: '视频已播完，平台未确认',
    advancing: '切换下一个',
    quizWait: '弹题待处理',
    paused: '已暂停',
    blocked: '需要人工处理',
    needsReview: '无法确认完成',
    completed: '视频任务已完成',
    stopped: '已停止',
  };

  function create(onChange) {
    let state = 'idle';
    let enteredAt = Date.now();
    const transitions = [];
    let blockedReason = '';
    let noteReason = '';

    function canGo(next) {
      const allowed = TRANSITIONS[state];
      return !!allowed && allowed.indexOf(next) !== -1;
    }

    function go(next, reason) {
      if (next === state) return false;
      if (!canGo(next)) {
        if (typeof console !== 'undefined') {
          console.warn('[状态机] 拒绝非法转移 ' + state + ' -> ' + next + (reason ? ' (' + reason + ')' : ''));
        }
        return false;
      }
      const previous = state;
      state = next;
      enteredAt = Date.now();
      if (next === 'blocked') blockedReason = reason || '';
      else if (next !== 'idle') blockedReason = '';
      if (next === 'awaitingConfirm' || next === 'needsReview') noteReason = reason || '';
      transitions.push({ from: previous, to: next, at: enteredAt, reason: reason || '' });
      if (transitions.length > 200) transitions.splice(0, transitions.length - 200);
      if (onChange) {
        try {
          onChange(next, previous, reason || '');
        } catch (e) {
          /* 回调异常不得影响状态机 */
        }
      }
      return true;
    }

    return {
      go: go,
      canGo: canGo,
      state() {
        return state;
      },
      label(s) {
        return LABELS[s || state] || s || state;
      },
      enteredAt() {
        return enteredAt;
      },
      blockedReason() {
        return blockedReason;
      },
      noteReason() {
        return noteReason;
      },
      transitions() {
        return transitions.slice();
      },
      reset() {
        state = 'idle';
        enteredAt = Date.now();
        blockedReason = '';
        noteReason = '';
        transitions.length = 0;
      },
      isRunningState() {
        return ['locating', 'playing', 'settling', 'advancing'].indexOf(state) !== -1;
      },
      isHoldingState() {
        return ['paused', 'blocked', 'awaitingConfirm', 'needsReview'].indexOf(state) !== -1;
      },
    };
  }

  return { create, TRANSITIONS, LABELS };
})();

// ===========================================================================
// 80-runner.js
// ===========================================================================
// ---------------------------------------------------------------------------
// runner.js —— 主调度：把状态机、DOM 操作、播放器事件接起来
//
// 并发安全：所有异步流程携带 runToken；start/stop/pause/resume 递增 token，
// 旧链路在下一个检查点自行退出。
// 循环安全：advanceGuard 限制切换次数；settle 超时进入 awaitingConfirm，
// 绝不把"视频播完"当成"平台确认完成"。
// ---------------------------------------------------------------------------
const Runner = (function () {
  const R = {
    hooks: {},
    runToken: 0,
    running: false,
    currentJob: null,
    currentTitle: '',
    playedCount: 0, // 真正开始播放过的次数
    confirmedCount: 0, // 平台确认完成的次数
    pendingConfirm: new Set(), // 用户跳过、待人工确认的 stableKey
    lastError: '',
    resumeAttempts: 0,
    playRejectCount: 0,
    advanceGuard: 0,
    advancePending: false,
    userIntentUntil: 0,
    lastUserIntentAt: 0,
    lastBlurAt: 0,
    lastStalledAt: 0,
    settleObserver: null,
    settleTimer: null,
    watchdogTimer: null,
    advanceTimer: null,
    resumeTimer: null,
    pauseClassifyTimer: null,
    awaitingSince: 0,
    awaitingTries: 0,
    awaitingReason: '',
    completion: null,
    intentDoc: null,
    intentHandler: null,
    blurView: null,
    blurHandler: null,
    stalledVideo: null,
    stalledHandler: null,
  };

  const sm = StateMachine.create(function (next, previous, reason) {
    if (next === 'blocked') R.lastError = reason || '未知错误';
    Log.debug('状态：' + previous + ' -> ' + next + (reason ? '（' + reason + '）' : ''));
    publish();
  });

  function isStale(token) {
    return token !== R.runToken;
  }

  function snapshot() {
    return {
      state: sm.state(),
      stateLabel: sm.label(),
      running: R.running,
      jobTitle: R.currentTitle || (R.currentJob ? R.currentJob.title : ''),
      jobState: R.currentJob ? R.currentJob.state : '',
      jobType: R.currentJob ? R.currentJob.type : '',
      video: VideoCtl.info(),
      playedCount: R.playedCount,
      confirmedCount: R.confirmedCount,
      pendingCount: R.pendingConfirm.size,
      lastError: R.lastError,
      blockedReason: sm.blockedReason(),
      noteReason: sm.noteReason(),
      resumeAttempts: R.resumeAttempts,
      advanceGuard: R.advanceGuard,
      awaitingSince: R.awaitingSince,
      awaitingTries: R.awaitingTries,
      completion: R.completion,
      quiz: typeof QuizRunner !== 'undefined' ? QuizRunner.snapshot() : null,
    };
  }

  function publish() {
    if (!R.hooks.onUpdate) return;
    try {
      R.hooks.onUpdate(snapshot());
    } catch (e) {
      /* 面板异常不得影响主流程 */
    }
  }

  // ---------------- 清理 ----------------
  function stopSettle() {
    if (R.settleTimer) {
      clearTimeout(R.settleTimer);
      R.settleTimer = null;
    }
    if (R.settleObserver) {
      Dom.stopObserver(R.settleObserver);
      R.settleObserver = null;
    }
  }

  function stopWatchdog() {
    if (R.watchdogTimer) {
      clearInterval(R.watchdogTimer);
      R.watchdogTimer = null;
    }
  }

  function stopPendingTimers() {
    if (R.advanceTimer) {
      clearTimeout(R.advanceTimer);
      R.advanceTimer = null;
    }
    if (R.resumeTimer) {
      clearTimeout(R.resumeTimer);
      R.resumeTimer = null;
    }
    if (R.pauseClassifyTimer) {
      clearTimeout(R.pauseClassifyTimer);
      R.pauseClassifyTimer = null;
    }
  }

  function unbindMediaSignals() {
    if (R.intentDoc && R.intentHandler) {
      try {
        R.intentDoc.removeEventListener('pointerdown', R.intentHandler, true);
        R.intentDoc.removeEventListener('keydown', R.intentHandler, true);
      } catch (e) {
        /* ignore */
      }
    }
    R.intentDoc = null;
    R.intentHandler = null;

    if (R.blurView && R.blurHandler) {
      try {
        R.blurView.removeEventListener('blur', R.blurHandler);
      } catch (e) {
        /* ignore */
      }
    }
    R.blurView = null;
    R.blurHandler = null;

    if (R.stalledVideo && R.stalledHandler) {
      try {
        R.stalledVideo.removeEventListener('stalled', R.stalledHandler);
        R.stalledVideo.removeEventListener('waiting', R.stalledHandler);
      } catch (e) {
        /* ignore */
      }
    }
    R.stalledVideo = null;
    R.stalledHandler = null;
  }

  // 只记录时间，不拦截任何事件
  function bindMediaSignals(video) {
    unbindMediaSignals();
    if (!video) return;

    let doc = null;
    let view = null;
    try {
      doc = video.ownerDocument;
      view = doc.defaultView;
    } catch (e) {
      doc = null;
    }
    if (!doc) return;

    R.intentDoc = doc;
    R.intentHandler = function () {
      R.lastUserIntentAt = Date.now();
      R.userIntentUntil = R.lastUserIntentAt + 3000;
    };
    doc.addEventListener('pointerdown', R.intentHandler, true);
    doc.addEventListener('keydown', R.intentHandler, true);

    if (view) {
      R.blurView = view;
      R.blurHandler = function () {
        R.lastBlurAt = Date.now();
      };
      view.addEventListener('blur', R.blurHandler);
    }

    R.stalledVideo = video;
    R.stalledHandler = function () {
      R.lastStalledAt = Date.now();
    };
    video.addEventListener('stalled', R.stalledHandler);
    video.addEventListener('waiting', R.stalledHandler);
  }

  function stopAll() {
    stopSettle();
    stopWatchdog();
    stopPendingTimers();
    unbindMediaSignals();
    R.advancePending = false;
    VideoCtl.detach();
  }

  function block(reason) {
    stopAll();
    R.lastError = reason;
    Log.error(reason);
    sm.go('blocked', reason);
    publish();
  }

  // 证据不足导致无法确认完成：这是"不确定"，不是"失败"，也不是"完成"
  function enterNeedsReview(reason, completion) {
    stopAll();
    if (completion) R.completion = completion;
    Log.warn('无法确认完成：' + reason);
    sm.go('needsReview', reason);
    publish();
  }

  // ---------------- 页面判定 ----------------
  function isCoursePage() {
    if (CourseUrl.isExcluded(location.href)) return false;
    if (CourseUrl.isStudyPage(location.href)) return true;
    // 路径不认识但确实是学习页时兜底：必须同时具备目录与任务点容器
    try {
      const hasCatalog = !!document.querySelector('#coursetree') || !!document.querySelector('.posCatalog_level');
      const hasTask = !!document.querySelector('.ans-attach-ct') || !!document.querySelector('.ans-job-icon');
      return hasCatalog && hasTask;
    } catch (e) {
      return false;
    }
  }

  function checkFinished(job) {
    if (!job || !job.container) return false;
    try {
      if (!job.container.isConnected) return false;
    } catch (e) {
      /* ignore */
    }
    return CourseTree.readJobState(job.container).state === 'finished';
  }

  // ---------------- 停滞监测（P0-5）----------------
  function startWatchdog(token) {
    stopWatchdog();
    if (!Config.get('watchdogEnabled')) return;
    const stallTimeoutMs = Number(Config.get('stallTimeoutMs')) || 75000;
    let lastPosition = -1;
    let lastChangeAt = Date.now();
    let loadingSince = 0;

    R.watchdogTimer = setInterval(function () {
      if (isStale(token) || sm.state() !== 'playing') return;
      const info = VideoCtl.info();
      if (!info) return;

      // 暂停/结束不归停滞管，重置基准
      if (info.paused || info.ended) {
        lastChangeAt = Date.now();
        loadingSince = 0;
        return;
      }

      if (Math.abs(info.currentTime - lastPosition) > 0.5) {
        lastPosition = info.currentTime;
        lastChangeAt = Date.now();
        loadingSince = 0;
        return;
      }

      const stalledMs = Date.now() - lastChangeAt;

      // 区分缓冲：readyState/networkState 表明仍在加载时只观察，不判异常
      const loading = info.readyState < 3 || info.networkState === 2;
      if (loading) {
        if (!loadingSince) loadingSince = Date.now();
        if (stalledMs >= stallTimeoutMs) {
          Log.warn(
            '播放位置 ' +
              Math.round(stalledMs / 1000) +
              ' 秒未前进，但仍在加载（readyState=' +
              info.readyState +
              '，networkState=' +
              info.networkState +
              '），继续观察'
          );
          lastChangeAt = Date.now();
        }
        return;
      }

      loadingSince = 0;
      if (stalledMs >= stallTimeoutMs) {
        block(
          '播放进度已 ' +
            Math.round(stalledMs / 1000) +
            ' 秒无变化（未暂停、未结束、非加载中），判定为停滞，需要人工确认'
        );
      } else {
        publish();
      }
    }, Number(Config.get('watchdogIntervalMs')) || 15000);
  }

  // ---------------- 播放一个任务点 ----------------
  async function playJob(job, token, options) {
    const opts = options || {};
    if (isStale(token) || !job) return;
    R.currentJob = job;
    R.currentTitle = job.title;
    if (sm.state() !== 'locating') sm.go('locating', 'job-selected');
    publish();

    let video = null;
    const attempts = Math.max(1, Number(Config.get('locateMaxAttempts')) || 6);
    for (let i = 0; i < attempts; i++) {
      if (isStale(token)) return;
      video = CourseTree.findVideoInJob(job);
      if (video) break;
      Log.debug('未找到 video，等待就绪（' + (i + 1) + '/' + attempts + '）');
      await Dom.waitTimeout(Number(Config.get('locateRetryDelayMs')) || 2500);
    }
    if (isStale(token)) return;
    if (!video) {
      block('任务点内未找到可播放的 video：' + job.title);
      return;
    }

    VideoCtl.attach(video, {
      onEnded: function () {
        onEnded(token);
      },
      onPause: function () {
        onPause(token);
      },
      onPlaying: function () {
        R.resumeAttempts = 0;
        publish();
      },
      onError: function (v, error) {
        onMediaError(error);
      },
      onLoaded: function () {
        publish();
      },
      onTick: function () {
        publish();
      },
    });
    bindMediaSignals(video);

    const result = await VideoCtl.play(video);
    if (isStale(token)) return;

    if (!result.ok) {
      R.playRejectCount++;
      const maxReject = Number(Config.get('maxPlayReject')) || 3;
      if (R.playRejectCount > maxReject) {
        block('浏览器拒绝自动播放（' + result.reason + '）。请在页面上手动点击一次，再按"继续"');
        return;
      }
      Log.warn('播放被拒绝（' + result.reason + '），2 秒后重试');
      await Dom.waitTimeout(2000);
      if (isStale(token)) return;
      return playJob(job, token, { continued: true });
    }

    R.playRejectCount = 0;
    R.resumeAttempts = 0;
    if (!opts.continued) R.playedCount++;
    Config.saveCursor({ jobKey: job.stableKey || job.id, jobTitle: job.title });
    if (sm.state() !== 'playing') sm.go('playing', 'play-started');
    startWatchdog(token);
    publish();
  }

  // ---------------- 结束 -> 等待平台确认 ----------------
  function onEnded(token) {
    if (isStale(token)) return;
    if (sm.state() !== 'playing') return;
    Log.info('视频播放结束（播放器事件）：' + R.currentTitle);
    stopWatchdog();
    sm.go('settling', 'video-ended');
    publish();
    beginSettle(token);
  }

  function beginSettle(token) {
    const job = R.currentJob;
    if (!job) {
      enterAwaitingConfirm(token, null, 0);
      return;
    }
    if (checkFinished(job)) {
      Log.info('平台已标记该任务点完成');
      R.confirmedCount++;
      goAdvance(token);
      return;
    }

    const container = job.container;
    const view = (container.ownerDocument && container.ownerDocument.defaultView) || window;
    try {
      R.settleObserver = new view.MutationObserver(function () {
        if (isStale(token)) return;
        if (checkFinished(job)) {
          Log.info('平台已标记该任务点完成（DOM 已更新）');
          R.confirmedCount++;
          stopSettle();
          goAdvance(token);
        }
      });
      R.settleObserver.observe(container, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class', 'aria-label', 'title'],
      });
    } catch (e) {
      Log.warn('无法监听完成态变化，将依赖超时判定', e && e.message);
    }

    const timeoutMs = Number(Config.get('settleTimeoutMs')) || 20000;
    R.settleTimer = setTimeout(function () {
      if (isStale(token)) return;
      stopSettle();
      if (checkFinished(job)) {
        R.confirmedCount++;
        goAdvance(token);
        return;
      }
      // 关键修正：不再用播放进度冒充平台确认
      enterAwaitingConfirm(token, job, timeoutMs);
    }, timeoutMs);
  }

  // 视频已播完但平台未确认：可恢复异常态，绝不自动记为成功
  function enterAwaitingConfirm(token, job, waitedMs) {
    if (isStale(token)) return;
    stopSettle();
    stopWatchdog();
    R.awaitingSince = Date.now();
    R.awaitingTries = 0;
    R.awaitingReason =
      '等待平台确认超时（' +
      Math.round((Number(waitedMs) || 0) / 1000) +
      ' 秒）：' +
      (job ? job.title : '(未知任务)');
    Log.warn(R.awaitingReason);
    Log.warn('视频播放已结束，但平台未把该任务点标记为完成。可选择「继续等待」「跳过并记录」或「停止」。');
    sm.go('awaitingConfirm', 'platform-not-confirmed');
    publish();
  }

  function goAdvance(token) {
    if (isStale(token)) return;
    if (R.advancePending) return;
    R.advancePending = true;
    R.advanceTimer = setTimeout(async function () {
      R.advancePending = false;
      R.advanceTimer = null;
      if (isStale(token)) return;
      await advance(token);
    }, 1000);
  }

  // ---------------- 完成度评估（P0-4）----------------
  function evaluateCompletion(jobs, inaccessible) {
    const progress = CourseTree.catalogProgress();
    const summary = CourseTree.readCatalogSummary();

    const videoUnfinished = jobs.filter(function (job) {
      return job.state === 'unfinished' && (job.type === 'video' || job.type === 'unknown');
    });
    const unknownJobs = jobs.filter(function (job) {
      return job.state === 'unknown';
    });

    const reasons = [];
    if (inaccessible && inaccessible.length) {
      reasons.push('frame-unreadable: ' + inaccessible.length + ' 个子框架不可读');
    }
    if (unknownJobs.length) {
      reasons.push('task-unknown-state: ' + unknownJobs.length + ' 个任务点无法判定完成状态');
    }
    if (videoUnfinished.length) {
      reasons.push('video-unfinished: ' + videoUnfinished.length + ' 个视频任务点未完成');
    }
    if (progress.ok && progress.unknown > 0) {
      reasons.push('catalog-unknown: ' + progress.unknown + ' 个节的待完成计数无法解析');
    }
    if (R.pendingConfirm.size) {
      reasons.push('pending-confirm: ' + R.pendingConfirm.size + ' 个已跳过的任务待人工确认');
    }

    const videoComplete =
      videoUnfinished.length === 0 && unknownJobs.length === 0 && R.pendingConfirm.size === 0;

    let verdict;
    if (videoUnfinished.length > 0) verdict = 'incomplete';
    else if (!videoComplete) verdict = 'unverifiable';
    else verdict = 'complete';

    return {
      verdict: verdict,
      videoComplete: videoComplete,
      pendingOthers: progress.ok ? progress.pending : null,
      totalLeaves: progress.ok ? progress.total : 0,
      reasons: reasons,
      catalog: progress,
      summary: summary,
    };
  }

  // ---------------- 章节测验闸门 ----------------
  // 需求：本节视频播完后，先把本节未完成的章节测验做掉，再切下一节。
  // 任何一步不确定就转人工（awaitingConfirm），绝不盲点或伪造完成。
  async function waitForQuizPage(token, timeoutMs) {
    const started = Date.now();
    const limit = Number(timeoutMs) || 15000;
    while (Date.now() - started < limit) {
      if (isStale(token)) return false;
      try {
        if (typeof ChapterQuizRunner !== 'undefined' && ChapterQuizRunner.isQuizPage()) return true;
      } catch (e) {
        /* ignore */
      }
      await new Promise(function (r) {
        setTimeout(r, 500);
      });
    }
    return false;
  }

  function enterQuizManual(reason) {
    R.awaitingSince = Date.now();
    R.awaitingTries = 0;
    R.awaitingReason = reason;
    Log.warn(reason);
    sm.go('awaitingConfirm', 'chapter-quiz-manual');
    publish();
  }

  async function processPendingQuiz(token, jobs) {
    if (Config.get('quizGateEnabled') === false) return 'off';
    if (typeof CourseTree.findPendingWorkJobs !== 'function') return 'off';
    if (typeof ChapterQuizRunner === 'undefined') return 'off';

    const pending = CourseTree.findPendingWorkJobs(jobs);
    if (!pending.length) return 'none';

    Log.info('本节还有 ' + pending.length + ' 个未完成章节测验，先做完再继续');
    sm.go('quizWait', 'chapter-quiz-pending');
    publish();

    let onQuizPage = false;
    try {
      onQuizPage = ChapterQuizRunner.isQuizPage();
    } catch (e) {
      onQuizPage = false;
    }

    if (!onQuizPage) {
      const opened = CourseTree.openWorkJob(pending[0]);
      Log.info('打开测验入口：' + (opened.ok ? opened.by : '失败(' + opened.reason + ')'));
      if (!opened.ok) {
        enterQuizManual('本节有 ' + pending.length + ' 个测验，但找不到可点击入口，请手动完成');
        return 'blocked';
      }
      const appeared = await waitForQuizPage(token, Number(Config.get('quizPageTimeoutMs')) || 20000);
      if (!appeared) {
        enterQuizManual('已尝试打开测验，但没等到题目出现，请手动完成');
        return 'blocked';
      }
    }

    if (isStale(token)) return 'blocked';

    let result = null;
    try {
      result = await ChapterQuizRunner.runAuto({
        submit: true,
        force: false,
        confirmTimeoutMs: 8000,
      });
    } catch (e) {
      result = { ok: false, phase: 'exception', error: String((e && e.message) || e) };
    }

    if (isStale(token)) return 'blocked';

    if (!result || !result.ok) {
      const why = result ? (result.phase || '') + ' ' + (result.error || '') : '无返回';
      enterQuizManual('本章测验自动完成失败（' + why + '），请手动完成后点「继续」');
      return 'blocked';
    }

    Log.info('本章测验已完成并提交（填 ' + (result.filled || 0) + ' 题），继续连播');
    return 'handled';
  }

  // ---------------- 推进 ----------------
  async function advance(token) {
    if (isStale(token)) return;
    R.advanceGuard++;
    if (R.advanceGuard > 200) {
      block('单次运行切换次数已达上限（200），已停止以避免循环');
      return;
    }
    if (sm.state() !== 'advancing') sm.go('advancing', 'advance');
    publish();

    const beforeDetail = CourseTree.enumerateDetail();
    const beforeJobs = beforeDetail.jobs;
    const beforeSignature = CourseTree.signatureOf(beforeJobs);

    // 1) 同页仍有未完成视频（排除已跳过待确认的任务）
    const pick = CourseTree.pickNextVideoTarget(beforeJobs, R.currentJob ? R.currentJob.id : null, {
      excludeKeys: R.pendingConfirm,
    });
    if (pick.job) {
      Log.info('同页下一个任务点：' + pick.job.title);
      await playJob(pick.job, token);
      return;
    }

    // 1.5) 本节视频已无可播项 → 先做本节未完成的章节测验，做完再切下一节
    const gate = await processPendingQuiz(token, beforeJobs);
    if (gate === 'handled') {
      if (isStale(token)) return;
      // 测验做完后重新评估本节，可能还有别的任务点
      await advance(token);
      return;
    }
    if (gate === 'blocked') return;

    // 2) 切换下一节
    let outcome = CourseTree.clickNextCatalogItem();
    Log.info('目录切换：' + (outcome.ok ? '成功（' + (outcome.title || '') + '）' : '失败（' + outcome.reason + '）'));
    if (!outcome.ok) {
      outcome = CourseTree.clickNextSectionButton();
      Log.info('按钮切换：' + (outcome.ok ? '成功（' + outcome.by + '）' : '失败（' + outcome.reason + '）'));
    }

    if (!outcome.ok) {
      const detail = CourseTree.enumerateDetail();
      const completion = evaluateCompletion(detail.jobs, detail.inaccessible);
      R.completion = completion;

      if (completion.videoComplete) {
        Log.info('视频任务已全部得到平台确认');
        R.confirmedCount = Math.max(R.confirmedCount, 1);
        if (completion.pendingOthers && completion.pendingOthers > 0) {
          Log.warn(
            '仍有 ' +
              completion.pendingOthers +
              ' 个非视频任务（如章节测验）未处理，整门课程尚未完成'
          );
        }
        sm.go('completed', 'video-complete');
        publish();
        return;
      }

      if (completion.verdict === 'incomplete') {
        block('仍有未完成的视频任务，但找不到下一个可操作节点：' + completion.reasons.join('; '));
        return;
      }

      enterNeedsReview(completion.reasons.join('; ') || '证据不足，无法确认任务完成状态', completion);
      return;
    }

    // 3) 等页面就绪
    const waited = await CourseTree.waitForJobsChange(
      beforeSignature,
      Number(Config.get('advanceTimeoutMs')) || 15000
    );
    if (isStale(token)) return;
    if (!waited.changed) {
      Log.warn('切换后页面结构未变化，重新定位');
    }
    R.currentJob = null;
    R.currentTitle = '';
    await locateAndPlay(token, null);
  }

  // ---------------- 定位并播放 ----------------
  async function locateAndPlay(token, afterJobId) {
    if (isStale(token)) return;
    if (sm.state() !== 'locating') sm.go('locating', afterJobId ? 'continue-after' : 'begin');
    publish();

    const detail = CourseTree.enumerateDetail();
    let jobs = detail.jobs;
    const inaccessible = detail.inaccessible;

    Log.debug('枚举任务点 ' + jobs.length + ' 个（文档 ' + detail.stats.documentCount + ' 个）');
    if (inaccessible.length) {
      Log.warn(
        '有 ' +
          inaccessible.length +
          ' 个不可读的子框架：' +
          inaccessible
            .slice(0, 3)
            .map(function (item) {
              return (item.reason || '?') + ' ' + String(item.src || '').slice(0, 80);
            })
            .join(' ; ')
      );
    }

    let pick = CourseTree.pickNextVideoTarget(jobs, afterJobId, { excludeKeys: R.pendingConfirm });
    let target = pick.job;

    if (!target && !jobs.length) {
      Log.info('未发现任务点，等待页面渲染（最多 8 秒）');
      const waited = await CourseTree.waitForJobsChange('', 8000);
      if (isStale(token)) return;
      jobs = waited.jobs;
      pick = CourseTree.pickNextVideoTarget(jobs, afterJobId, { excludeKeys: R.pendingConfirm });
      target = pick.job;
    }

    if (!target) {
      Log.info(
        '本页无可播任务点（未完成 ' +
          detail.stats.unfinished +
          '，已完成 ' +
          detail.stats.finished +
          '，未知 ' +
          detail.stats.unknown +
          '，不可读框架 ' +
          inaccessible.length +
          '）'
      );

      if (detail.stats.unknown > 0 && detail.stats.unfinished === 0) {
        // 有任务点但无法判定完成态：这是证据不足，不是失败
        const completion = evaluateCompletion(detail.jobs, detail.inaccessible);
        enterNeedsReview(
          completion.reasons.join('; ') || '存在无法判定完成状态的任务点，请用"诊断"查看结构',
          completion
        );
        return;
      }
      await advance(token);
      return;
    }

    await playJob(target, token);
  }

  // ---------------- 暂停分诊（P0-2）----------------
  function onPause(token) {
    if (isStale(token)) return;
    if (sm.state() !== 'playing') return;

    // 观察窗口：弹题 DOM 可能滞后于 pause 事件，先等再分类
    const observeMs = Number(Config.get('pauseObserveMs')) || 900;
    if (R.pauseClassifyTimer) clearTimeout(R.pauseClassifyTimer);
    R.pauseClassifyTimer = setTimeout(function () {
      R.pauseClassifyTimer = null;
      if (isStale(token)) return;
      if (sm.state() !== 'playing') return;
      classifyAndHandlePause(token);
    }, observeMs);
  }

  function classifyAndHandlePause(token) {
    const video = VideoCtl.current();
    if (!video) return;

    const verdict = PauseClassifier.classify({
      video: video,
      now: Date.now(),
      userIntentAt: R.lastUserIntentAt,
      lastBlurAt: R.lastBlurAt,
      lastStalledAt: R.lastStalledAt,
    });

    Log.info('暂停分诊：' + verdict.reason + '（' + verdict.label + '）');

    if (verdict.reason === 'ended') {
      onEnded(token);
      return;
    }

    if (verdict.reason === 'quiz') {
      stopWatchdog();
      sm.go('quizWait', 'quiz-detected');
      Log.warn('检测到交互题目，已暂停自动连播，请处理（脚本不会自动提交）');
      startQuiz(token);
      publish();
      return;
    }

    if (verdict.reason === 'user') {
      stopWatchdog();
      sm.go('paused', 'user-pause');
      Log.info('检测到你手动暂停，脚本不会自动恢复。需要继续时点面板「继续」');
      publish();
      return;
    }

    if (verdict.reason === 'background') {
      stopWatchdog();
      sm.go('paused', 'background-pause');
      Log.warn('页面已切到后台/失焦，平台暂停了播放。回到前台后点面板「继续」（脚本不会自动恢复）');
      publish();
      return;
    }

    if (verdict.reason === 'loading') {
      Log.info('视频缓冲/加载中，等待恢复，不做干预');
      publish();
      return;
    }

    // unexpected：有限恢复
    R.resumeAttempts++;
    const max = Number(Config.get('maxResumeAttempts')) || 3;
    if (R.resumeAttempts > max) {
      block('视频被反复暂停（已尝试恢复 ' + max + ' 次），可能有需要人工处理的交互');
      return;
    }
    Log.warn('意外暂停（' + R.resumeAttempts + '/' + max + '），尝试恢复播放');
    publish();

    R.resumeTimer = setTimeout(async function () {
      R.resumeTimer = null;
      if (isStale(token) || sm.state() !== 'playing') return;
      const current = VideoCtl.current();
      if (!current || !current.paused || current.ended) return;
      const result = await VideoCtl.play(current);
      if (!result.ok) Log.warn('恢复播放失败：' + result.reason);
    }, 700);
  }

  function onMediaError(error) {
    const message = error
      ? (error.code !== undefined ? 'code=' + error.code : '') + ' ' + (error.message || '')
      : '未知';
    block('视频加载错误（' + message.trim() + '），不做自动刷新');
  }

  // ---------------- 弹题流程（阶段 D1）----------------
  function startQuiz(token) {
    if (typeof QuizRunner === 'undefined') return;
    QuizRunner.setHooks({
      onUpdate: function () {
        publish();
      },
      onResolved: function (reason) {
        resumeAfterQuiz(token, reason);
      },
    });
    QuizRunner.start();
  }

  // 弹题结束后重新检查播放器与任务状态，再继续播放
  function resumeAfterQuiz(token, reason) {
    if (isStale(token)) return;
    if (sm.state() !== 'quizWait') return;

    Log.info('弹题流程结束（' + (reason || 'resolved') + '），重新检查播放器');
    R.runToken++;
    const next = R.runToken;
    R.running = true;
    sm.go('locating', 'quiz-done');
    publish();

    (async function () {
      if (isStale(next)) return;
      if (R.currentJob && R.currentJob.container && R.currentJob.container.isConnected) {
        const jobState = CourseTree.readJobState(R.currentJob.container);
        if (jobState.state === 'unfinished') {
          await playJob(R.currentJob, next, { continued: true });
          return;
        }
      }
      await locateAndPlay(next, R.currentJob ? R.currentJob.id : null);
    })().catch(function (e) {
      Log.error('弹题后恢复失败：' + (e && e.message));
      block('弹题后恢复失败：' + (e && e.message));
    });
  }

  function stopQuiz() {
    if (typeof QuizRunner === 'undefined') return;
    try {
      QuizRunner.stop();
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------- awaitingConfirm 的三个操作 ----------------
  function keepWaiting() {
    if (sm.state() !== 'awaitingConfirm') {
      Log.warn('当前状态不是「等待平台确认」，忽略');
      return false;
    }
    R.awaitingTries++;
    const maxTries = Number(Config.get('awaitingConfirmMaxWait')) || 3;
    if (R.awaitingTries > maxTries) {
      Log.warn('「继续等待」已达上限 ' + maxTries + ' 次，请选择跳过或停止');
      return false;
    }
    R.runToken++;
    const token = R.runToken;
    R.running = true;
    sm.go('settling', 'keep-waiting');
    Log.info('继续等待平台确认（第 ' + R.awaitingTries + ' 次）');
    publish();
    beginSettle(token);
    return true;
  }

  function skipAwaiting() {
    if (sm.state() !== 'awaitingConfirm') {
      Log.warn('当前状态不是「等待平台确认」，忽略');
      return false;
    }
    const job = R.currentJob;
    if (job && job.stableKey) {
      R.pendingConfirm.add(job.stableKey);
      Config.savePending(R.pendingConfirm);
      Log.warn(
        '已跳过并记录待确认任务：' + job.title + '（key=' + job.stableKey + '）。跳过不等于完成，不计入成功数。'
      );
    } else {
      Log.warn('当前任务缺少稳定标识，跳过未记录，下一轮可能再次选中');
    }
    R.runToken++;
    const token = R.runToken;
    R.running = true;
    goAdvance(token);
    return true;
  }

  // ---------------- 对外控制 ----------------
  function start() {
    if (R.running) {
      Log.warn('已在运行中');
      return false;
    }
    if (!isCoursePage()) {
      Log.error('当前页面不是可运行的学习页（' + CourseUrl.describe(location.href) + '），未启动');
      return false;
    }
    R.runToken++;
    const token = R.runToken;
    R.running = true;
    R.playedCount = 0;
    R.confirmedCount = 0;
    R.advanceGuard = 0;
    R.resumeAttempts = 0;
    R.playRejectCount = 0;
    R.lastError = '';
    R.currentJob = null;
    R.currentTitle = '';
    R.awaitingTries = 0;
    R.completion = null;
    R.pendingConfirm = new Set(Config.readPending());

    if (sm.state() !== 'stopped' && sm.state() !== 'idle') sm.reset();
    Log.info('开始：自然播放连播（1.0 倍速，不改进度）');
    if (R.pendingConfirm.size) {
      Log.info('已载入 ' + R.pendingConfirm.size + ' 个历史跳过任务，本次将排除它们');
    }
    publish();

    locateAndPlay(token, null).catch(function (e) {
      Log.error('主流程异常：' + (e && e.message));
      block('主流程异常：' + (e && e.message));
    });
    return true;
  }

  function pause() {
    const state = sm.state();
    if (['locating', 'playing', 'settling', 'advancing'].indexOf(state) === -1) {
      Log.warn('当前状态（' + sm.label() + '）不可暂停');
      return false;
    }
    R.runToken++;
    R.running = false;
    const video = VideoCtl.current();
    stopAll();
    if (video) {
      try {
        video.pause();
      } catch (e) {
        /* ignore */
      }
    }
    sm.go('paused', 'user-pause');
    Log.info('已暂停');
    publish();
    return true;
  }

  function resume() {
    const state = sm.state();

    // 弹题待处理时点"继续"：结束弹题并交还播放
    if (state === 'quizWait') {
      stopQuiz();
      R.runToken++;
      const token = R.runToken;
      R.running = true;
      Log.info('用户结束弹题处理，继续播放');
      resumeAfterQuiz(token, 'user-continue');
      return true;
    }

    if (['paused', 'blocked', 'awaitingConfirm', 'needsReview'].indexOf(state) === -1) {
      Log.warn('当前状态（' + sm.label() + '）不可继续');
      return false;
    }
    R.runToken++;
    const token = R.runToken;
    R.running = true;
    R.resumeAttempts = 0;
    R.playRejectCount = 0;
    Log.info('继续');
    publish();

    (async function () {
      if (sm.state() !== 'locating') sm.go('locating', 'resume');

      // 当前任务点仍存在且未完成：直接接着播
      if (R.currentJob && R.currentJob.container && R.currentJob.container.isConnected) {
        const jobState = CourseTree.readJobState(R.currentJob.container);
        if (jobState.state === 'unfinished') {
          await playJob(R.currentJob, token, { continued: true });
          return;
        }
      }
      await locateAndPlay(token, R.currentJob ? R.currentJob.id : null);
    })().catch(function (e) {
      Log.error('继续失败：' + (e && e.message));
      block('继续失败：' + (e && e.message));
    });
    return true;
  }

  function stop() {
    R.runToken++;
    R.running = false;
    stopQuiz();
    const video = VideoCtl.current();
    stopAll();
    if (video) {
      try {
        video.pause();
      } catch (e) {
        /* ignore */
      }
    }
    sm.go('stopped', 'user-stop');
    Log.info('已停止');
    publish();
    return true;
  }

  // ---------------- 诊断导出 ----------------
  function diagnose() {
    const detail = CourseTree.enumerateDetail();
    const catalog = CourseTree.catalogEntries();
    const progress = CourseTree.catalogProgress();
    const summary = CourseTree.readCatalogSummary();
    const tabs = CourseTree.readTaskTabs();
    const video = VideoCtl.current();

    // 明确区分四种情况，而不是笼统的"没找到任务点"
    let jobDiagnosis = 'ok';
    if (!detail.jobs.length) {
      if (detail.documents.length <= 1 && detail.inaccessible.length) {
        jobDiagnosis = 'frame-inaccessible';
      } else if (!detail.inaccessible.length && !document.querySelector('.ans-attach-ct') && !document.querySelector('.ans-job-icon')) {
        jobDiagnosis = 'selector-miss';
      } else {
        jobDiagnosis = 'not-loaded';
      }
    }

    return {
      at: new Date().toISOString(),
      page: {
        // 脱敏：只保留路径与白名单参数，去掉 enc/cpi/t/stuenc 等会话参数
        path: (function () {
          try {
            const u = new URL(location.href);
            const keep = ['courseId', 'courseid', 'chapterId', 'chapterid', 'clazzid'];
            const params = [];
            keep.forEach(function (key) {
              const value = u.searchParams.get(key);
              if (value) params.push(key + '=' + value);
            });
            return u.origin + u.pathname + (params.length ? '?' + params.join('&') : '');
          } catch (e) {
            return '(unavailable)';
          }
        })(),
        type: CourseUrl.describe(location.href),
        isStudyPage: CourseUrl.isStudyPage(location.href),
        identity: CourseUrl.identity(location.href),
        visibility: (function () {
          try {
            return { state: document.visibilityState, hasFocus: document.hasFocus() };
          } catch (e) {
            return null;
          }
        })(),
      },
      state: snapshot(),
      jobDiagnosis: jobDiagnosis,
      stats: detail.stats,
      inaccessible: detail.inaccessible.map(function (item) {
        return {
          depth: item.depth,
          reason: item.reason,
          src: String(item.src || '').slice(0, 160),
        };
      }),
      documents: detail.documents.map(function (entry) {
        let frameSrc = '';
        try {
          frameSrc = entry.frameEl ? Dom.frameUrl(entry.frameEl) : '(top)';
        } catch (e) {
          frameSrc = '';
        }
        return {
          depth: entry.depth,
          frameSrc: String(frameSrc).slice(0, 160),
          jobContainers: entry.doc.querySelectorAll('.ans-attach-ct').length,
          jobIcons: entry.doc.querySelectorAll('.ans-job-icon').length,
          iframes: entry.doc.querySelectorAll('iframe').length,
          videos: entry.doc.querySelectorAll('video').length,
        };
      }),
      jobs: detail.jobs.map(function (job) {
        return {
          id: job.id,
          stableKey: job.stableKey,
          type: job.type,
          state: job.state,
          stateBy: job.stateBy,
          stateLabel: job.stateLabel,
          title: job.title,
          hasVideo: !!CourseTree.findVideoInJob(job),
          skippedAsPending: R.pendingConfirm.has(job.stableKey),
        };
      }),
      catalog: {
        rootSelector: catalog.rootSelector,
        leaves: progress.total,
        firstLayer: progress.firstLayerCount,
        pending: progress.pending,
        unknown: progress.unknown,
        summary: summary,
        activeIndex: catalog.items.findIndex(function (el) {
          return CourseTree.readCatalogPending && el.classList && el.classList.contains(SEL.catalogActiveClass);
        }),
      },
      taskTabs: tabs,
      currentVideo: video
        ? {
            id: video.id || '',
            className: String(video.className || ''),
            info: VideoCtl.info(video),
          }
        : null,
      selectorsUsed: SEL,
    };
  }

  return {
    setHooks(hooks) {
      R.hooks = hooks || {};
    },
    start,
    pause,
    resume,
    stop,
    keepWaiting,
    skipAwaiting,
    // ---- 弹题（阶段 D1）----
    applyQuizSuggestion(options) {
      if (typeof QuizRunner === 'undefined') return false;
      return QuizRunner.applySuggestion(options);
    },
    submitQuiz() {
      if (typeof QuizRunner === 'undefined') return false;
      return QuizRunner.submit();
    },
    dismissQuiz() {
      if (typeof QuizRunner === 'undefined') return false;
      return QuizRunner.dismiss();
    },
    quizSnapshot() {
      return typeof QuizRunner !== 'undefined' ? QuizRunner.snapshot() : null;
    },
    diagnose,
    snapshot,
    evaluateCompletion,
    isRunning() {
      return R.running;
    },
    state() {
      return sm.state();
    },
    stateLabel() {
      return sm.label();
    },
    pendingKeys() {
      return Array.from(R.pendingConfirm);
    },
  };
})();

// ===========================================================================
// 86-quiz-runner.js
// ===========================================================================
// ---------------------------------------------------------------------------
// quiz-runner.js —— 视频弹题编排（阶段 D1）
//
// 流程：检测 → 解析 → 请求模型 → 展示建议 → 用户确认勾选 → 用户提交 → 等题目消失 → 交还播放
//
// 安全与成本约束：
//   - 只用 MutationObserver + 低频兜底检查，不截图、不持续调模型
//   - 同一题目 hash 只请求一次（Llm 内部缓存 + 本模块 lastHash 双重去重）
//   - 提交永远需要用户显式点击；脚本只负责"应用建议（勾选）"
//   - 无法识别 / 请求失败 → 进入 manual，不重试、不猜
//   - 识别不到题目时不会阻塞播放（由 Runner 决定恢复时机）
// ---------------------------------------------------------------------------
const QuizRunner = (function () {
  const PHASE = {
    idle: 'idle',
    detecting: 'detecting',
    requesting: 'requesting',
    suggested: 'suggested',
    manual: 'manual',
    submitted: 'submitted',
    resolved: 'resolved',
  };

  const S = {
    phase: PHASE.idle,
    question: null,
    suggestion: null,
    error: '',
    lastHash: '',
    applied: false,
    submitted: false,
    startedAt: 0,
  };

  let hooks = {};
  let observer = null;
  let fallbackTimer = null;
  let debounceTimer = null;
  let missingStreak = 0;
  let running = false;
  let handling = false;

  function publish() {
    if (hooks.onUpdate) {
      try {
        hooks.onUpdate(snapshot());
      } catch (e) {
        /* ignore */
      }
    }
  }

  function snapshot() {
    return {
      phase: S.phase,
      question: S.question
        ? {
            type: S.question.type,
            typeLabel: QuizModel.TYPE_LABELS[S.question.type] || '未知题型',
            stem: S.question.stem,
            options: S.question.options.map(function (option) {
              return { letter: option.letter, text: option.text };
            }),
            hash: S.question.hash,
          }
        : null,
      suggestion: S.suggestion,
      error: S.error,
      applied: S.applied,
      submitted: S.submitted,
      ai: Llm.stats(),
      llmConfig: (function () {
        const cfg = Llm.readConfig();
        return {
          enabled: cfg.enabled,
          mode: cfg.mode,
          model: cfg.model,
          proxyUrl: cfg.proxyUrl,
          hasKey: !!cfg.apiKey,
        };
      })(),
    };
  }

  function resetState() {
    S.phase = PHASE.idle;
    S.question = null;
    S.suggestion = null;
    S.error = '';
    S.lastHash = '';
    S.applied = false;
    S.submitted = false;
    S.startedAt = Date.now();
    missingStreak = 0;
    handling = false;
  }

  function stopTimers() {
    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        /* ignore */
      }
      observer = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // ---------- 检测 ----------
  function detectAndHandle() {
    if (!running || handling) return;
    const root = QuizModel.findRoot(document);

    if (!root) {
      missingStreak++;
      // 连续两次看不到题目才认定结束，避免渲染抖动误判
      if (missingStreak >= 2 && S.phase !== PHASE.idle && S.phase !== PHASE.resolved) {
        resolve('quiz-gone');
      }
      return;
    }

    missingStreak = 0;
    if (S.phase === PHASE.suggested || S.phase === PHASE.manual || S.phase === PHASE.submitted) {
      return; // 已有题目在处理，等用户操作
    }
    handleQuestion();
  }

  function scheduleDetect() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      detectAndHandle();
    }, 400);
  }

  async function handleQuestion() {
    if (handling) return;
    handling = true;
    try {
      const question = QuizModel.parse(document);

      if (!question.ok) {
        S.phase = PHASE.manual;
        S.error = '无法可靠识别题目：' + question.reason;
        S.question = null;
        Log.warn(S.error + '，已转人工处理');
        publish();
        return;
      }

      if (question.hash === S.lastHash) {
        return; // 同一题不重复处理
      }

      S.lastHash = question.hash;
      S.question = question;
      S.suggestion = null;
      S.applied = false;
      S.submitted = false;
      S.error = '';

      const cfg = Llm.readConfig();
      if (!cfg.enabled) {
        S.phase = PHASE.manual;
        S.error = 'AI 未开启（面板里打开"AI 弹题"并配置模型后才调用）';
        Log.info('检测到弹题，但 AI 未开启：' + question.stem.slice(0, 40));
        publish();
        return;
      }

      S.phase = PHASE.requesting;
      publish();
      Log.info('检测到弹题，请求模型：' + question.stem.slice(0, 40));

      const result = await Llm.ask(question);
      if (!running) return;

      if (!result.ok) {
        S.phase = PHASE.manual;
        S.error = result.error || '模型未返回可用答案';
        Log.warn('弹题请求失败：' + S.error + '（不会重试同一题）');
        publish();
        return;
      }

      S.suggestion = result.payload;
      S.phase = PHASE.suggested;
      Log.info(
        '建议答案：' +
          result.payload.letters.join(',') +
          '（confidence=' + result.payload.confidence.toFixed(2) +
          (result.payload.uncertain ? '，模型自述不确定' : '') + '）'
      );
      publish();

      // 只勾选，不提交；提交永远需要用户点击
      if (Config.get('quizAutoApply') === true) {
        applySuggestion({ silent: true });
      }
    } catch (e) {
      S.phase = PHASE.manual;
      S.error = '弹题处理异常：' + (e && e.message);
      Log.error(S.error);
      publish();
    } finally {
      handling = false;
    }
  }

  // ---------- 应用建议（仅勾选）----------
  function applySuggestion(options) {
    const silent = options && options.silent;
    if (!S.question || !S.suggestion) {
      if (!silent) Log.warn('当前没有可应用的建议');
      return false;
    }

    const letters = new Set(S.suggestion.letters);
    let clicked = 0;

    for (const option of S.question.options) {
      if (!letters.has(option.letter)) continue;
      const target = option.input || option.box;
      if (!target) continue;
      if (Dom.click(target)) clicked++;
    }

    S.applied = clicked > 0;
    Log.info('已应用建议（勾选 ' + clicked + ' 项），提交仍需你确认');
    publish();
    return S.applied;
  }

  // ---------- 提交（必须显式调用）----------
  function submit() {
    if (!S.question) {
      Log.warn('当前没有题目可提交');
      return false;
    }
    if (S.submitted) {
      Log.warn('该题已提交过');
      return false;
    }

    const root = S.question.root;
    let button = null;
    for (const selector of SEL.quizSubmitButton) {
      try {
        const found = root ? root.querySelector(selector) : document.querySelector(selector);
        if (found) {
          button = found;
          break;
        }
      } catch (e) {
        /* ignore */
      }
    }
    if (!button) {
      // 视频弹题不一定有独立提交按钮（勾选即生效），此时不强行点击
      S.submitted = true;
      S.phase = PHASE.submitted;
      Log.warn('未找到提交按钮：该题型可能勾选即生效，请确认后手动继续');
      publish();
      return false;
    }

    if (!Dom.click(button)) {
      Log.warn('提交按钮点击失败');
      return false;
    }

    S.submitted = true;
    S.phase = PHASE.submitted;
    Log.info('已点击提交按钮');
    publish();
    return true;
  }

  // ---------- 人工处理 / 结束 ----------
  function dismiss() {
    S.phase = PHASE.manual;
    S.error = '已转人工处理，脚本不再对该题调用模型';
    publish();
    return true;
  }

  function resolve(reason) {
    if (S.phase === PHASE.resolved) return;
    S.phase = PHASE.resolved;
    stopTimers();
    running = false;
    Log.info('弹题流程结束（' + (reason || 'resolved') + '）');
    publish();
    if (hooks.onResolved) {
      try {
        hooks.onResolved(reason || 'resolved');
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---------- 生命周期 ----------
  function start() {
    if (running) return false;
    resetState();
    running = true;
    S.phase = PHASE.detecting;
    publish();

    try {
      const target = document.body || document.documentElement;
      observer = new MutationObserver(function () {
        scheduleDetect();
      });
      observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    } catch (e) {
      Log.warn('MutationObserver 不可用，改用低频检查');
    }

    // 兜底：MutationObserver 可能在 iframe 内部变化时收不到
    fallbackTimer = setInterval(detectAndHandle, 2000);
    detectAndHandle();
    Log.info('开始监听视频弹题');
    return true;
  }

  function stop() {
    running = false;
    stopTimers();
    if (S.phase !== PHASE.resolved) S.phase = PHASE.idle;
    publish();
  }

  return {
    setHooks(next) {
      hooks = next || {};
    },
    start,
    stop,
    snapshot,
    applySuggestion,
    submit,
    dismiss,
    resolve,
    PHASE,
    isRunning() {
      return running;
    },
  };
})();

// ===========================================================================
// 87-chapter-quiz.js
// ===========================================================================
// ---------------------------------------------------------------------------
// chapter-quiz.js —— 独立章节测验适配器与编排（阶段 D2）
//
// 真实页面证据（2026-11-10 实测 mooc1/.../mooc-ans/work/doHomeWorkNew?workId=…）：
//   题目容器   .TiMu（类 .TiMu newTiMu，带 data="0..n"）
//   题号       .Zy_TItle i
//   题型标签   .newZy_TItle（【单选题】/【多选题】）
//   题干       .Zy_TItle .fontLabel
//   选项列表   ul.Zy_ulTop li
//   选项字母   li span[data]（单选 .num_option / 多选 .num_option_dx，都有 data）
//   选项文本   li a.after
//   选项标识   li[qid]、li[qtype]（0=单选 1=多选）、li[role]=radio/checkbox
//   点击行为   li[onclick]=addChoice(this) / addMultipleChoice(this)
//   按钮       .btnSave（暂时保存）、.btnSubmit（提交）
//   分页       无
//
// 关键陷阱（实测）：
//   **选项字母顺序被打乱**：第 1 题的 DOM 顺序对应字母 [D,A,C,B]。
//   因此必须用 data 属性取字母，绝不能按 DOM 索引推断 A/B/C/D。
//
// 字体加密（实测）：
//   题干与选项带 .font-cxsecret，textContent 是被替换的字符
//   （如「全面从严治党」读作「全嵅从嵆治嵃」），
//   而 font-cxsecret 是 base64 内联 TTF，**渲染后才显示正确文字**。
//   本轮用 16×16 Canvas 粗特征比对做了可行性验证：失败（"嵅"→"面" 排第 194 位）。
//   因此本模块只检测并标记 encrypted，不尝试解密；标记后不请求模型。
// ---------------------------------------------------------------------------
const ChapterQuizAdapter = (function () {
  const QSEL = {
    root: '.TiMu',
    num: '.Zy_TItle i',
    typeLabel: '.newZy_TItle',
    stem: '.Zy_TItle .fontLabel',
    optionList: 'ul.Zy_ulTop',
    optionItem: 'li',
    optionLetter: 'span[data]',
    optionText: 'a.after',
    saveBtn: '.btnSave',
    submitBtn: '.btnSubmit',
    encrypted: '.font-cxsecret',
  };

  const TYPE = {
    single: 'single',
    multiple: 'multiple',
    judge: 'judge',
    blank: 'blank',
    unknown: 'unknown',
  };

  const TYPE_LABELS = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    blank: '填空题',
    unknown: '未知题型',
  };

  function textOf(el) {
    if (!el) return '';
    try {
      return String(el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  function isSelected(li) {
    if (!li) return null;
    try {
      const cls = String(li.className || '');
      // 用连字符/空白做边界，避免把 before-after-checkbox 里的 "check" 误判为选中，
      // 同时仍能识别 before-after-select 这类选中标记。
      if (/(^|[\s-])(selected|select|active|cur|checked)([\s-]|$)/i.test(cls)) return true;
      const aria = li.getAttribute('aria-checked');
      if (aria === 'true') return true;
      if (aria === 'false') return false;
      // 没有明确选中标记时按未选中处理；填写后 verify() 会重新读取并报告不一致，
      // 因此宁可漏判"已选中"（多填一次，可自检），也不要误判"已选中"（拒绝填写）。
      return false;
    } catch (e) {
      return null;
    }
  }

  function mapType(label, options) {
    if (label.indexOf('单选') !== -1) return TYPE.single;
    if (label.indexOf('多选') !== -1) return TYPE.multiple;
    if (label.indexOf('判断') !== -1) return TYPE.judge;
    if (label.indexOf('填空') !== -1) return TYPE.blank;
    if (label.indexOf('简答') !== -1 || label.indexOf('问答') !== -1) return TYPE.unknown;

    const roles = options.map(function (o) { return o.role; }).filter(Boolean);
    if (roles.length && roles.every(function (r) { return r === 'radio'; })) return TYPE.single;
    if (roles.some(function (r) { return r === 'checkbox'; })) return TYPE.multiple;
    return TYPE.unknown;
  }

  function parseOne(el, index) {
    const numEl = el.querySelector(QSEL.num);
    const typeEl = el.querySelector(QSEL.typeLabel);
    const stemEl = el.querySelector(QSEL.stem);

    const typeLabel = textOf(typeEl);
    let stem = textOf(stemEl);
    // 去掉题干开头的【单选题】前缀
    if (typeLabel && stem.indexOf(typeLabel) === 0) {
      stem = stem.slice(typeLabel.length).trim();
    }

    const liList = Dom.toArray(el.querySelectorAll(QSEL.optionList + ' ' + QSEL.optionItem));
    const options = liList.map(function (li, i) {
      const letterEl = li.querySelector(QSEL.optionLetter);
      // 实测结构：<span class="num_option" data="D">A</span>
      //   data   = 平台内部答案标识（可能被随机化，用于防抓取）
      //   文本   = 用户在页面上看到的字母（A/B/C/D，按视觉顺序）
      // 必须区分这两者：给用户/模型看的是文本，回填时也按文本匹配，
      // 绝不能把 data 当成显示字母，否则答案会错位。
      const internal = letterEl ? String(letterEl.getAttribute('data') || '').trim().toUpperCase() : '';
      const display = letterEl ? textOf(letterEl).toUpperCase() : '';
      return {
        letter: /^[A-H]$/.test(display) ? display : '',
        internal: /^[A-H]$/.test(internal) ? internal : '',
        text: textOf(li.querySelector(QSEL.optionText)),
        qid: li.getAttribute('qid') || '',
        qtype: li.getAttribute('qtype') || '',
        role: li.getAttribute('role') || '',
        index: i,
        selected: isSelected(li),
        el: li,
      };
    });

    const type = mapType(typeLabel, options);
    const encrypted = !!el.querySelector(QSEL.encrypted);
    const num = textOf(numEl);

    // 稳定标识：题号 + 题型 + 选项 qid + 内部标识序列
    // 用 internal 而不是显示字母，因为显示字母可能随顺序变化，内部标识更稳定
    const qidKey = options.map(function (o) { return o.qid; }).join('-');
    const internalKey = options.map(function (o) { return o.internal; }).join('');
    const key = [num || '#' + index, type, qidKey, internalKey].join('|');

    const missingLetters = options.some(function (o) { return !o.letter; });

    return {
      index: index,
      key: key,
      num: num,
      type: type,
      typeLabel: typeLabel || TYPE_LABELS[type],
      stem: stem,
      options: options,
      encrypted: encrypted,
      missingLetters: missingLetters,
      answered: options.some(function (o) { return o.selected === true; }),
      el: el,
    };
  }

  /**
   * 解析整份测验（只读）。
   * @returns {{ok:boolean, reason:string, count:number, questions:Array, encryptedCount:number, warnings:Array}}
   */
  function parse(doc) {
    const target = doc || document;
    let nodes = [];
    try {
      nodes = Dom.toArray(target.querySelectorAll(QSEL.root));
    } catch (e) {
      nodes = [];
    }

    if (!nodes.length) {
      return {
        ok: false,
        reason: 'no-quiz-root',
        count: 0,
        questions: [],
        encryptedCount: 0,
        warnings: [],
      };
    }

    const questions = nodes.map(function (el, i) {
      return parseOne(el, i);
    });

    const warnings = [];
    const encryptedCount = questions.filter(function (q) { return q.encrypted; }).length;
    if (encryptedCount) {
      warnings.push(
        encryptedCount +
          ' 道题的内容被 .font-cxsecret 字体加密，textContent 是替换字符。' +
          '本模块不做解密，这些题不会请求模型。'
      );
    }
    const noLetter = questions.filter(function (q) { return q.missingLetters; }).length;
    if (noLetter) {
      warnings.push(noLetter + ' 道题缺少选项字母（data 属性），已标记为不可自动填写');
    }
    const unknown = questions.filter(function (q) { return q.type === TYPE.unknown; }).length;
    if (unknown) {
      warnings.push(unknown + ' 道题题型无法识别，需要人工处理');
    }

    return {
      ok: true,
      reason: '',
      count: questions.length,
      questions: questions,
      encryptedCount: encryptedCount,
      warnings: warnings,
    };
  }

  // 当前是否处于测验页面
  function detect(doc) {
    const target = doc || document;
    try {
      if (!/\/work\/doHomeWorkNew/i.test(String(target.URL || ''))) {
        return { isQuizPage: false, reason: 'url-not-quiz' };
      }
      const count = target.querySelectorAll(QSEL.root).length;
      return { isQuizPage: count > 0, count: count, reason: count ? '' : 'no-questions' };
    } catch (e) {
      return { isQuizPage: false, reason: 'error' };
    }
  }

  /**
   * 按显示字母填写答案（绝不按 DOM 索引或内部标识）。
   * @param {object} question parse 出来的单题
   * @param {string[]} letters 目标字母（用户/模型看到的字母）
   * @param {object} options { force:boolean, source:'text'|'vision' }
   *   force=true 才覆盖已选答案
   *   source='vision' 表示答案来自视觉识别，此时加密题目允许填写
   *   （加密只是让 textContent 不可读，不影响选项字母与点击；
   *     视觉识别正是为了绕过这一点，答案与选项的对应仍由 letter 保证）
   */
  function fill(question, letters, options) {
    const opts = options || {};
    if (!question) return { ok: false, applied: 0, errors: ['没有题目'] };
    if (question.encrypted && opts.source !== 'vision') {
      return {
        ok: false,
        applied: 0,
        errors: ['题目文本加密；只有答案来自视觉识别时才允许填写'],
      };
    }
    if (question.missingLetters) {
      return { ok: false, applied: 0, errors: ['选项缺少字母标识，无法安全匹配'] };
    }

    const target = new Set((letters || []).map(function (l) { return String(l).toUpperCase(); }));
    const errors = [];
    const known = new Set(question.options.map(function (o) { return o.letter; }));

    for (const letter of target) {
      if (!known.has(letter)) errors.push('选项不存在：' + letter);
    }
    if (errors.length) return { ok: false, applied: 0, errors: errors };

    // 已有答案且未授权覆盖：拒绝
    if (question.answered && !opts.force) {
      return { ok: false, applied: 0, errors: ['该题已有填写内容，需明确授权才能覆盖'] };
    }

    let applied = 0;
    for (const option of question.options) {
      const shouldPick = target.has(option.letter);
      const currently = option.selected;

      // currently 为 null 表示无法判断，交给外层填写后自检
      if (shouldPick) {
        if (currently === true) continue;
        if (Dom.click(option.el)) applied++;
      } else if (currently === true) {
        // 多选题需要取消未选中的已选项（addMultipleChoice 是 toggle）
        if (Dom.click(option.el)) applied++;
      }
    }

    return { ok: true, applied: applied, errors: [] };
  }

  // 填写后自检：重新读 DOM，确认目标字母都被选中
  function verify(question, letters) {
    if (!question) return { ok: false, detail: 'no-question' };
    const target = new Set((letters || []).map(function (l) { return String(l).toUpperCase(); }));
    const unknown = [];
    const wrong = [];

    for (const option of question.options) {
      const now = isSelected(option.el);
      if (now === null) {
        unknown.push(option.letter);
        continue;
      }
      const want = target.has(option.letter);
      if (now !== want) wrong.push({ letter: option.letter, selected: now, want: want });
    }

    if (unknown.length && !wrong.length) {
      return { ok: false, unknown: unknown, detail: '无法读取选中状态，需要人工确认' };
    }
    if (wrong.length) {
      return { ok: false, wrong: wrong, detail: '填写后状态与预期不一致' };
    }
    return { ok: true, detail: 'ok' };
  }

  function buttons(doc) {
    const target = doc || document;
    const result = { save: null, submit: null };
    try {
      result.save = target.querySelector(QSEL.saveBtn);
      result.submit = target.querySelector(QSEL.submitBtn);
    } catch (e) {
      /* ignore */
    }
    return result;
  }

  return {
    QSEL,
    TYPE,
    TYPE_LABELS,
    parse,
    detect,
    fill,
    verify,
    buttons,
    isSelected,
  };
})();

// ===========================================================================
// 88-chapter-quiz-runner.js
// ===========================================================================
// ---------------------------------------------------------------------------
// chapter-quiz-runner.js —— 章节测验编排（阶段 D2）
//
// 复用 D1 的 Llm 与 QuizModel 校验，但使用独立的状态与令牌，
// 不与视频弹题的 QuizRunner 共用任何运行锁（用户要求）。
//
// 安全边界：
//   - analyze 只读 + 请求模型，绝不改答案
//   - fillAll 只在用户显式调用时执行，默认不覆盖已填答案
//   - submit 只在用户显式确认时点击，且提交后重新读取页面反馈
//   - 加密题 / 未知题型 / 缺字母题：跳过，标记人工处理
//   - 所有异步环节检查令牌，页面切换或用户停止后丢弃过期结果
// ---------------------------------------------------------------------------
const ChapterQuizRunner = (function () {
  const PHASE = {
    idle: 'idle',
    analyzing: 'analyzing',
    ready: 'ready',
    filling: 'filling',
    filled: 'filled',
    submitted: 'submitted',
    error: 'error',
  };

  const S = {
    phase: PHASE.idle,
    quiz: null,
    suggestions: {}, // key -> { status, letters, reason, confidence, uncertain, error }
    error: '',
    token: 0,
    submitted: false,
    lastVerify: null,
  };

  let hooks = {};

  function publish() {
    if (!hooks.onUpdate) return;
    try {
      hooks.onUpdate(snapshot());
    } catch (e) {
      /* ignore */
    }
  }

  function snapshot() {
    const quiz = S.quiz;
    const list = quiz
      ? quiz.questions.map(function (q) {
          const s = S.suggestions[q.key] || null;
          return {
            key: q.key,
            num: q.num,
            type: q.type,
            typeLabel: q.typeLabel,
            stem: q.stem.slice(0, 80),
            encrypted: q.encrypted,
            missingLetters: q.missingLetters,
            answered: q.answered,
            options: q.options.map(function (o) {
              return { letter: o.letter, text: o.text.slice(0, 60) };
            }),
            status: s ? s.status : 'pending',
            letters: s && s.letters ? s.letters : [],
            reason: s && s.reason ? s.reason : '',
            confidence: s && s.confidence !== undefined ? s.confidence : 0,
            uncertain: s ? s.uncertain === true : false,
            error: s && s.error ? s.error : '',
          };
        })
      : [];

    const analyzed = list.filter(function (q) {
      return q.status === 'ok' || q.status === 'invalid';
    }).length;
    const manual = list.filter(function (q) {
      return q.status === 'skip' || q.status === 'error' || q.status === 'invalid';
    }).length;

    return {
      phase: S.phase,
      error: S.error,
      submitted: S.submitted,
      lastVerify: S.lastVerify,
      total: quiz ? quiz.count : 0,
      encryptedCount: quiz ? quiz.encryptedCount : 0,
      analyzedCount: analyzed,
      manualCount: manual,
      warnings: quiz ? quiz.warnings : [],
      ai: typeof Llm !== 'undefined' ? Llm.stats() : null,
      items: list,
    };
  }

  // 测验页可能在同源 iframe 内（实测 #frame_content-zj → doHomeWorkNew），
  // 而连播脚本在顶层 frame 运行，所以必须主动找承载题目的那个 document。
  const QUIZ_URL_RE = /doHomeWorkNew|work\/doWork/i;

  function resolveQuizDoc() {
    // 1) 当前文档本身就是测验页
    try {
      if (document.querySelector(ChapterQuizAdapter.QSEL.root)) return document;
    } catch (e) {
      /* ignore */
    }
    // 2) 遍历同源子框架
    let docs = [];
    try {
      const collected = Dom.collectDocuments(window, SEL.maxFrameDepth);
      docs = (collected && collected.documents) || [];
    } catch (e) {
      docs = [];
    }
    for (const entry of docs) {
      const doc = entry && entry.doc;
      if (!doc) continue;
      let url = '';
      try {
        url = String((doc.location && doc.location.href) || '');
      } catch (e) {
        url = '';
      }
      let hasQuiz = false;
      try {
        hasQuiz = !!doc.querySelector(ChapterQuizAdapter.QSEL.root);
      } catch (e) {
        hasQuiz = false;
      }
      if (hasQuiz && QUIZ_URL_RE.test(url)) return doc;
    }
    // 3) 退一步：任何含题目容器的同源文档
    for (const entry of docs) {
      const doc = entry && entry.doc;
      if (!doc) continue;
      try {
        if (doc.querySelector(ChapterQuizAdapter.QSEL.root)) return doc;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  function isQuizPage() {
    return !!resolveQuizDoc();
  }

  // 转成 Llm/QuizModel 认识的结构；hash 加前缀避免与视频弹题缓存串味
  function toLlmQuestion(q) {
    return {
      ok: true,
      type: q.type,
      stem: q.stem,
      options: q.options.map(function (o) {
        return { letter: o.letter, text: o.text };
      }),
      hash: 'chapter:' + q.key,
    };
  }

  function reset() {
    S.phase = PHASE.idle;
    S.quiz = null;
    S.suggestions = {};
    S.error = '';
    S.submitted = false;
    S.lastVerify = null;
    S.token++;
  }

  function stop() {
    S.token++;
    if (S.phase === PHASE.analyzing) S.phase = PHASE.idle;
    publish();
  }

  // ---------- 分析（只读 + 请求模型）----------
  // 两条路径：
  //   未加密 → 文本模型（D1 的 Llm）
  //   加密   → 渲染成图 → 本地视觉桥接 → DSH 独立会话（V4.1 Flash Low）
  async function analyze() {
    if (!isQuizPage()) {
      S.error = '当前不是章节测验页面';
      S.phase = PHASE.error;
      publish();
      return false;
    }

    const token = ++S.token;
    const quizDoc = resolveQuizDoc() || document;
    const quiz = ChapterQuizAdapter.parse(quizDoc);
    S.quiz = quiz;
    S.quizDoc = quizDoc;
    S.suggestions = {};
    S.error = '';
    S.submitted = false;
    S.phase = PHASE.analyzing;
    publish();

    const textCfg = typeof Llm !== 'undefined' ? Llm.readConfig() : null;
    const visionCfg = typeof QuizVision !== 'undefined' ? QuizVision.readConfig() : null;

    const warnings = [];
    let requested = 0;

    for (const q of quiz.questions) {
      if (token !== S.token) return false; // 用户停止或页面切换

      if (q.type === 'unknown' || q.type === 'blank') {
        S.suggestions[q.key] = { status: 'skip', error: '题型暂不支持自动解析' };
        continue;
      }
      if (q.missingLetters) {
        S.suggestions[q.key] = { status: 'skip', error: '选项缺少字母标识' };
        continue;
      }

      // ---- 加密题：走视觉 ----
      if (q.encrypted || window.__cxHost) {
        if (!visionCfg || !visionCfg.enabled) {
          S.suggestions[q.key] = {
            status: 'skip',
            error: '题目内容加密，需要开启「视觉识别」并启动本地桥接',
          };
          continue;
        }
        if (typeof QuizImage === 'undefined') {
          S.suggestions[q.key] = { status: 'skip', error: '图像模块未加载' };
          continue;
        }

        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        const image = QuizImage.render(q);
        if (!image.ok) {
          S.suggestions[q.key] = {
            status: 'skip',
            error: '题目图像生成失败：' + image.reason + '（可能需要人工）',
          };
          continue;
        }
        if (image.unsupported && image.unsupported.length) {
          S.suggestions[q.key] = {
            status: 'skip',
            error: '题目含图片/公式，当前版本不自动识别，请人工处理',
          };
          continue;
        }

        requested++;
        const letters = q.options.map(function (o) { return o.letter; });
        const result = await QuizVision.ask(image.dataUrl, q.key, letters);
        if (token !== S.token) return false;

        if (result.ok && result.answers && result.answers.length) {
          S.suggestions[q.key] = {
            status: 'ok',
            source: 'vision',
            letters: result.answers,
            reason: '视觉识别（' + (result.elapsedMs || 0) + 'ms）',
            confidence: 0.8,
            uncertain: result.status === 'uncertain',
          };
        } else if (result.status === 'uncertain') {
          S.suggestions[q.key] = { status: 'invalid', error: '视觉识别结果不确定，请人工判断' };
        } else {
          S.suggestions[q.key] = { status: 'error', error: result.error || '视觉识别失败' };
        }
        publish();
        continue;
      }

      // ---- 未加密：走文本模型 ----
      if (!textCfg || !textCfg.enabled) {
        S.suggestions[q.key] = { status: 'skip', error: 'AI 未开启（面板「AI 设置」里启用）' };
        continue;
      }

      requested++;
      const result = await Llm.ask(toLlmQuestion(q));
      if (token !== S.token) return false;

      if (result.ok && result.payload) {
        S.suggestions[q.key] = {
          status: 'ok',
          source: 'text',
          letters: result.payload.letters,
          reason: result.payload.reason,
          confidence: result.payload.confidence,
          uncertain: result.payload.uncertain,
        };
      } else if (result.error && result.error.indexOf('校验失败') !== -1) {
        S.suggestions[q.key] = { status: 'invalid', error: result.error };
      } else {
        S.suggestions[q.key] = { status: 'error', error: result.error || '请求失败' };
      }
      publish();
    }

    if (token !== S.token) return false;
    if (!requested) {
      warnings.push('没有任何题目被送进模型（可能全部加密且未开启视觉，或题型不支持）');
    }
    S.quiz.warnings = quiz.warnings.concat(warnings);
    S.phase = PHASE.ready;
    publish();
    return true;
  }

  // ---------- 填写（用户显式调用）----------
  function fillAll(options) {
    const opts = options || {};
    if (!S.quiz) {
      S.error = '还没有解析结果，请先「分析」';
      return false;
    }
    S.token++;
    S.phase = PHASE.filling;
    publish();

    let total = 0;
    const errors = [];
    const verified = [];

    for (const q of S.quiz.questions) {
      const s = S.suggestions[q.key];
      if (!s || s.status !== 'ok' || !s.letters || !s.letters.length) continue;

      const filled = ChapterQuizAdapter.fill(q, s.letters, {
        force: opts.force === true,
        source: s.source === 'vision' ? 'vision' : 'text',
      });
      if (!filled.ok) {
        errors.push(q.num + '：' + filled.errors.join('；'));
        continue;
      }
      total += filled.applied;

      // 填写后立即自检，重新读取 DOM
      const check = ChapterQuizAdapter.verify(q, s.letters);
      verified.push({ num: q.num, ok: check.ok, detail: check.detail });
      if (!check.ok) errors.push(q.num + '：' + check.detail);
    }

    S.lastVerify = verified;
    S.phase = PHASE.filled;
    S.error = errors.join(' | ');
    publish();
    return errors.length === 0;
  }

  // 平台点「提交」后会弹「提示 / 确认提交? / 取消 / 提交」二次确认。
  // 这里只在弹窗里找"确认"类按钮，且排除取消类，避免误点。
  const CONFIRM_TEXT = /^(提交|确定|确认|是|继续)$/;
  const CANCEL_TEXT = /^(取消|关闭|返回|否)$/;

  function findConfirmButton() {
    const docs = [];
    try {
      const collected = Dom.collectDocuments(window, SEL.maxFrameDepth);
      docs.push.apply(docs, (collected && collected.documents) || []);
    } catch (e) {
      /* ignore */
    }
    docs.push({ doc: window.document });

    for (const entry of docs) {
      const doc = entry && entry.doc;
      if (!doc) continue;
      let nodes = [];
      try {
        nodes = Dom.toArray(doc.querySelectorAll('a,button,input[type=button],input[type=submit]'));
      } catch (e) {
        continue;
      }
      for (const node of nodes) {
        let text = '';
        try {
          text = String(node.textContent || node.value || '').replace(/\s+/g, '');
        } catch (e) {
          continue;
        }
        if (!text || CANCEL_TEXT.test(text) || !CONFIRM_TEXT.test(text)) continue;
        if (typeof Dom.isVisible === 'function' && !Dom.isVisible(node)) continue;
        // 必须处于可见弹层里，避免命中页面上的普通"提交"按钮
        let inPopup = false;
        let cur = node;
        for (let i = 0; i < 6 && cur; i++) {
          const cls = String(cur.className || '');
          const id = String(cur.id || '');
          if (/pop|dialog|layer|mask|modal|alert/i.test(cls) || /pop|dialog|layer|mask/i.test(id)) {
            inPopup = true;
            break;
          }
          cur = cur.parentElement;
        }
        if (inPopup) return node;
      }
    }
    return null;
  }

  async function submitAndConfirm(timeoutMs) {
    if (!S.quiz) {
      S.error = '还没有解析结果';
      return { ok: false, error: 'no-quiz' };
    }
    if (S.submitted) {
      S.error = '已经提交过';
      return { ok: false, error: 'already-submitted' };
    }

    const btns = ChapterQuizAdapter.buttons(S.quizDoc || document);
    if (!btns.submit) {
      S.error = '未找到提交按钮（.btnSubmit）';
      publish();
      return { ok: false, error: 'no-submit-button' };
    }
    if (!Dom.click(btns.submit)) {
      S.error = '提交按钮点击失败';
      publish();
      return { ok: false, error: 'submit-click-failed' };
    }

    // 等二次确认弹窗出现并点击
    const waitMs = Number(timeoutMs) || 8000;
    const started = Date.now();
    let confirmed = false;
    while (Date.now() - started < waitMs) {
      const btn = findConfirmButton();
      if (btn) {
        Dom.click(btn);
        confirmed = true;
        break;
      }
      await new Promise(function (r) {
        setTimeout(r, 300);
      });
    }

    S.submitted = true;
    S.phase = PHASE.submitted;
    publish();

    Log.info(confirmed ? '已提交并点了确认弹窗' : '已点提交，但没看到确认弹窗');

    // 提交后读反馈，不把"点成功"当"测验完成"
    await new Promise(function (r) {
      setTimeout(r, 1500);
    });
    let feedback = '';
    try {
      const pop = document.querySelector('.popDiv, .popup, .layui-layer, .maskDiv');
      if (pop && Dom.isVisible(pop)) feedback = String(pop.textContent || '').replace(/\s+/g, ' ').slice(0, 120);
    } catch (e) {
      /* ignore */
    }
    S.lastVerify = (S.lastVerify || []).concat([{ submitFeedback: feedback || '未捕获到页面反馈' }]);
    publish();

    return { ok: confirmed, feedback: feedback, error: confirmed ? '' : 'no-confirm-dialog' };
  }

  /**
   * 一键完成：识别 → 填写 → 提交（供连播流程调用）。
   * @param {object} options { submit:boolean, force:boolean }
   */
  async function runAuto(options) {
    const opts = options || {};

    if (!isQuizPage()) {
      return { ok: false, phase: 'detect', error: 'not-quiz-page' };
    }

    const analyzed = await analyze();
    if (!analyzed || S.phase !== PHASE.ready) {
      return { ok: false, phase: 'analyze', error: S.error || 'analyze-failed' };
    }

    const answered = Object.keys(S.suggestions).filter(function (k) {
      const s = S.suggestions[k];
      return s && s.status === 'ok' && s.letters && s.letters.length;
    });
    if (!answered.length) {
      return { ok: false, phase: 'analyze', error: 'no-answer' };
    }

    fillAll({ force: opts.force === true });

    const needFill = answered.length;
    const filledOk = (S.lastVerify || []).filter(function (v) {
      return v && v.ok;
    }).length;
    if (filledOk < needFill) {
      return { ok: false, phase: 'fill', error: 'fill-incomplete', filled: filledOk, need: needFill };
    }

    if (opts.submit === false) {
      return { ok: true, phase: 'filled', filled: filledOk };
    }

    const submitted = await submitAndConfirm(opts.confirmTimeoutMs);
    if (!submitted.ok) {
      return { ok: false, phase: 'submit', error: submitted.error, filled: filledOk };
    }
    return { ok: true, phase: 'submitted', filled: filledOk, feedback: submitted.feedback };
  }

  return {
    PHASE,
    setHooks(next) {
      hooks = next || {};
    },
    isQuizPage,
    snapshot,
    analyze,
    fillAll,
    // 面板按钮走的入口：现在会同时处理平台的二次确认弹窗
    submit: submitAndConfirm,
    submitAndConfirm,
    runAuto,
    stop,
    reset,
  };
})();

// ===========================================================================
// 89-quiz-panel.js
// ===========================================================================
// ---------------------------------------------------------------------------
// quiz-panel.js —— 章节测验页的独立控制面板（阶段 D2）
//
// 为什么单独一个面板：
//   测验页（mooc-ans/work/doHomeWorkNew）不是视频学习页，
//   复用主面板会带出开始/暂停/停止等无意义控件，且容易干扰 D1。
//   因此这里挂一个只含测验功能的小面板，与主 UI 完全独立。
// ---------------------------------------------------------------------------
const QuizPanel = (function () {
  const CSS = [
    ':host{all:initial}',
    '.panel{position:fixed;top:14px;right:14px;width:330px;z-index:2147483000;',
    'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2430;',
    'background:#fff;border:1px solid #d8dee9;border-radius:10px;box-shadow:0 6px 24px rgba(16,24,40,.16);overflow:hidden}',
    '.head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f4f7fc;border-bottom:1px solid #e4e9f2;cursor:move}',
    '.head .title{font-weight:600;flex:1}',
    '.badge{padding:1px 7px;border-radius:9px;font-size:11px;background:#e8edf7;color:#4a5670}',
    '.badge.warn{background:#fff4e2;color:#9a6414}',
    '.badge.ok{background:#e3f6e9;color:#1a7f45}',
    '.body{padding:9px 10px 10px}',
    '.row{display:flex;gap:6px;margin-bottom:3px}',
    '.row .k{color:#7c869b;flex:0 0 74px}',
    '.row .v{flex:1;min-width:0;word-break:break-all}',
    '.msg{margin:5px 0;padding:5px 7px;border-radius:6px;background:#fff4e2;color:#9a6414;display:none;font-size:11px;line-height:1.45}',
    '.msg.show{display:block}',
    '.btns{display:flex;gap:6px;margin:7px 0 4px}',
    '.btns button{flex:1;padding:5px 0;border-radius:6px;border:1px solid #cfd8e6;background:#fff;cursor:pointer;font-size:12px}',
    '.btns button:disabled{opacity:.45;cursor:not-allowed}',
    '.btns button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    '.btns button.danger{color:#b3261e;border-color:#e6b4b1}',
    '.list{max-height:230px;overflow:auto;margin-top:6px}',
    '.item{padding:5px 6px;border-radius:6px;background:#f8faff;margin-bottom:4px;font-size:11px;line-height:1.45}',
    '.item .n{font-weight:600;color:#33507a}',
    '.item .ans{color:#146b32;font-weight:600}',
    '.item .skip{color:#9a6414}',
    '.item .err{color:#b3261e}',
    '.hint{margin-top:5px;color:#8b93a7;font-size:11px;line-height:1.4}',
  ].join('');

  let host = null;
  let shadow = null;
  let refs = {};
  let unsubscribe = null;

  function el(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'cx-chapter-quiz-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = [
      '<div class="panel" id="panel">',
      '  <div class="head" id="head"><span class="title">章节测验助手</span><span class="badge" id="badge">未分析</span></div>',
      '  <div class="body">',
      '    <div class="row"><span class="k">题目总数</span><span class="v" id="total">—</span></div>',
      '    <div class="row"><span class="k">字体加密</span><span class="v" id="enc">—</span></div>',
      '    <div class="row"><span class="k">已分析</span><span class="v" id="analyzed">0</span></div>',
      '    <div class="row"><span class="k">需人工</span><span class="v" id="manual">0</span></div>',
      '    <div class="row"><span class="k">Token</span><span class="v" id="token">0</span></div>',
      '    <div class="msg" id="msg"></div>',
      '    <div class="btns">',
      '      <button id="analyze" class="primary">分析测验</button>',
      '      <button id="fill">填写答案</button>',
      '      <button id="submit" class="danger">提交</button>',
      '    </div>',
      '    <div class="list" id="list"></div>',
      '    <details class="ai">',
      '      <summary>视觉识别设置（题目加密时需要）</summary>',
      '      <div class="f"><label>启用</label><input type="checkbox" id="vOn" /></div>',
      '      <div class="f"><label>桥接地址</label><input type="text" id="vUrl" placeholder="http://127.0.0.1:8788" /></div>',
      '      <div class="f"><label>令牌</label><input type="text" id="vToken" placeholder="桥接启动时打印" /></div>',
      '      <div class="btns"><button id="vSave">保存</button><button id="vTest">测试连接</button></div>',
      '      <div class="hint" id="vHint">先把截图的题目喂给本地 DSH 视觉会话，再回填建议。</div>',
      '    </details>',
      '    <div class="hint" id="hint">分析只读；填写与提交都必须由你确认。</div>',
      '  </div>',
      '</div>',
    ].join('');
    while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

    refs = {
      badge: el('badge'),
      total: el('total'),
      enc: el('enc'),
      analyzed: el('analyzed'),
      manual: el('manual'),
      token: el('token'),
      msg: el('msg'),
      list: el('list'),
      analyze: el('analyze'),
      fill: el('fill'),
      submit: el('submit'),
      vOn: el('vOn'),
      vUrl: el('vUrl'),
      vToken: el('vToken'),
      vSave: el('vSave'),
      vTest: el('vTest'),
      vHint: el('vHint'),
    };

    el('analyze').addEventListener('click', function () {
      ChapterQuizRunner.analyze();
    });
    el('fill').addEventListener('click', function () {
      ChapterQuizRunner.fillAll({ force: false });
    });
    el('submit').addEventListener('click', function () {
      let ok = true;
      try {
        if (typeof window.confirm === 'function') {
          ok = window.confirm('确认提交这份测验？提交后通常不可修改。');
        }
      } catch (e) {
        ok = true;
      }
      if (ok) ChapterQuizRunner.submit();
    });

    // ---- 视觉设置 ----
    if (refs.vOn) {
      refs.vOn.checked = Config.get('visionEnabled') === true;
      refs.vUrl.value = Config.get('visionBridgeUrl') || '';
      refs.vToken.value = Config.get('visionBridgeToken') || '';

      refs.vOn.addEventListener('change', function () {
        Config.set('visionEnabled', refs.vOn.checked === true);
      });
      refs.vSave.addEventListener('click', function () {
        Config.set('visionBridgeUrl', refs.vUrl.value.trim());
        Config.set('visionBridgeToken', refs.vToken.value.trim());
        if (refs.vHint) refs.vHint.textContent = '视觉设置已保存';
      });
      refs.vTest.addEventListener('click', async function () {
        if (refs.vHint) refs.vHint.textContent = '正在连接…';
        const result = await QuizVision.health();
        if (refs.vHint) {
          refs.vHint.textContent = result.ok
            ? '连接成功；凭据：' + (result.data.credentialSource || '无') + (result.data.hasCredential ? '' : '（缺少 Key）')
            : '连接失败：' + result.error;
        }
      });
    }

    // 拖动
    let drag = null;
    const panel = el('panel');
    el('head').addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      event.preventDefault();
    });
    window.addEventListener('mousemove', function (event) {
      if (!drag) return;
      const rect = panel.getBoundingClientRect();
      const left = Math.max(4, Math.min(event.clientX - drag.dx, window.innerWidth - rect.width - 4));
      const top = Math.max(4, Math.min(event.clientY - drag.dy, window.innerHeight - rect.height - 4));
      panel.style.right = Math.max(4, window.innerWidth - left - rect.width) + 'px';
      panel.style.top = top + 'px';
    });
    window.addEventListener('mouseup', function () {
      drag = null;
    });

    ChapterQuizRunner.setHooks({ onUpdate: render });
    (document.body || document.documentElement).appendChild(host);

    unsubscribe = Log.subscribe(function (record) {
      if (record && (record.level === 'warn' || record.level === 'error')) {
        Log.debug('[测验面板] ' + record.message);
      }
    });

    // 初始解析一次（只读）
    const quiz = ChapterQuizAdapter.parse(document);
    render({
      phase: 'idle',
      total: quiz.count,
      encryptedCount: quiz.encryptedCount,
      analyzedCount: 0,
      manualCount: 0,
      warnings: quiz.warnings,
      items: quiz.questions.map(function (q) {
        return {
          num: q.num,
          typeLabel: q.typeLabel,
          stem: q.stem.slice(0, 70),
          encrypted: q.encrypted,
          status: 'pending',
          letters: [],
          reason: '',
          error: '',
        };
      }),
      ai: null,
      error: '',
    });
  }

  function render(snap) {
    if (!snap || !shadow) return;

    if (refs.total) refs.total.textContent = String(snap.total || 0) + ' 题';
    if (refs.enc) refs.enc.textContent = String(snap.encryptedCount || 0) + ' 题';
    if (refs.analyzed) refs.analyzed.textContent = String(snap.analyzedCount || 0);
    if (refs.manual) refs.manual.textContent = String(snap.manualCount || 0);
    if (refs.token) {
      const ai = snap.ai;
      refs.token.textContent = ai ? String((ai.promptTokens || 0) + (ai.completionTokens || 0)) : '0';
    }

    if (refs.badge) {
      const phase = snap.phase || 'idle';
      refs.badge.textContent =
        phase === 'analyzing' ? '分析中' : phase === 'ready' ? '已分析' : phase === 'submitted' ? '已提交' : phase === 'error' ? '出错' : '未分析';
      refs.badge.className = 'badge' + (phase === 'ready' ? ' ok' : phase === 'error' ? ' warn' : '');
    }

    if (refs.msg) {
      const parts = [];
      if (snap.error) parts.push(snap.error);
      if (snap.warnings && snap.warnings.length) parts.push(snap.warnings.join('；'));
      refs.msg.textContent = parts.join('\n');
      refs.msg.classList.toggle('show', parts.length > 0);
    }

    if (refs.analyze) refs.analyze.disabled = snap.phase === 'analyzing';
    if (refs.fill) refs.fill.disabled = snap.analyzedCount === 0;
    if (refs.submit) refs.submit.disabled = snap.submitted === true;

    if (refs.list) {
      refs.list.textContent = '';
      for (const item of snap.items || []) {
        const row = document.createElement('div');
        row.className = 'item';
        const head = document.createElement('div');
        head.className = 'n';
        head.textContent = '#' + (item.num || '?') + ' ' + (item.typeLabel || '') + (item.encrypted ? ' 🔒' : '');
        row.appendChild(head);

        const body = document.createElement('div');
        if (item.status === 'ok') {
          body.className = 'ans';
          body.textContent = '建议：' + (item.letters || []).join(',') + (item.reason ? ' · ' + item.reason.slice(0, 40) : '');
        } else if (item.status === 'skip') {
          body.className = 'skip';
          body.textContent = '跳过：' + (item.error || '');
        } else if (item.status === 'error' || item.status === 'invalid') {
          body.className = 'err';
          body.textContent = '失败：' + (item.error || '');
        } else {
          body.textContent = '未分析';
        }
        row.appendChild(body);
        refs.list.appendChild(row);
      }
    }
  }

  function unmount() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
  }

  return { mount, unmount, render };
})();

// ===========================================================================
// 90-ui.js
// ===========================================================================
// ---------------------------------------------------------------------------
// ui.js —— 悬浮控制面板（Shadow DOM 隔离，避免与页面样式冲突）
// 默认停靠右上角，可拖动、可折叠；不覆盖播放器中央控制区。
// ---------------------------------------------------------------------------
const UI = (function () {
  const CSS = [
    ':host{all:initial}',
    '.panel{position:fixed;top:14px;right:14px;width:296px;z-index:2147483000;',
    'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2430;',
    'background:#fff;border:1px solid #d8dee9;border-radius:10px;',
    'box-shadow:0 6px 24px rgba(16,24,40,.16);overflow:hidden;user-select:none}',
    '.panel.collapsed .body{display:none}',
    '.head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f4f7fc;',
    'border-bottom:1px solid #e4e9f2;cursor:move}',
    '.head .title{font-weight:600;font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.badge{padding:1px 7px;border-radius:9px;font-size:11px;background:#e8edf7;color:#4a5670;white-space:nowrap}',
    '.badge.playing{background:#e3f6e9;color:#1a7f45}',
    '.badge.settling,.badge.advancing,.badge.locating{background:#fff4e2;color:#9a6414}',
    '.badge.blocked{background:#fdeaea;color:#b3261e}',
    '.badge.paused{background:#eef0f4;color:#5b6478}',
    '.badge.completed{background:#e3f6e9;color:#1a7f45}',
    '.iconbtn{border:0;background:transparent;cursor:pointer;color:#5b6478;font-size:12px;padding:2px 4px;border-radius:4px}',
    '.iconbtn:hover{background:#e4e9f2}',
    '.body{padding:9px 10px 10px}',
    '.row{display:flex;gap:6px;margin-bottom:4px;align-items:baseline}',
    '.row .k{color:#7c869b;flex:0 0 62px}',
    '.row .v{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.err{margin:6px 0 4px;padding:5px 7px;border-radius:6px;background:#fdeaea;color:#b3261e;display:none;word-break:break-all}',
    '.err.show{display:block}',
    '.await{display:none;margin:6px 0;padding:7px 8px;border-radius:7px;background:#fff4e2;border:1px solid #f0d9ab}',
    '.await.show{display:block}',
    '.await .t{font-weight:600;color:#9a6414;margin-bottom:3px}',
    '.await .m{color:#7a5a20;font-size:11px;line-height:1.5;margin-bottom:5px;word-break:break-all}',
    '.await .btns{margin:0}',
    '.note{margin:6px 0 2px;padding:5px 7px;border-radius:6px;background:#eef4ff;color:#2a4a86;display:none;font-size:11px;line-height:1.5}',
    '.note.show{display:block}',
    '.quiz{display:none;margin:6px 0;padding:8px;border-radius:8px;background:#f7f4ff;border:1px solid #d9ccf5}',
    '.quiz.show{display:block}',
    '.quiz .t{font-weight:600;color:#5b3fa8;margin-bottom:4px}',
    '.quiz .stem{font-size:11px;line-height:1.5;color:#33284f;margin-bottom:5px;max-height:88px;overflow:auto}',
    '.quiz .opt{font-size:11px;line-height:1.45;padding:2px 5px;border-radius:4px;margin-bottom:2px;color:#3a3350}',
    '.quiz .opt.pick{background:#e2f6e6;color:#146b32;font-weight:600}',
    '.quiz .adv{font-size:11px;line-height:1.45;color:#5b6478;margin:4px 0;max-height:80px;overflow:auto;white-space:pre-wrap}',
    '.quiz .adv .bad{color:#b3261e}',
    '.quiz .btns{margin:4px 0 0}',
    '.ai{margin:6px 0 2px;font-size:11px;color:#5b6478}',
    '.ai summary{cursor:pointer;color:#2f6fed}',
    '.ai .f{display:flex;gap:4px;margin-top:4px;align-items:center}',
    '.ai .f label{flex:0 0 66px;color:#7c869b}',
    '.ai .f input[type=text],.ai .f input[type=password],.ai .f select{flex:1;min-width:0;font-size:11px;padding:2px 4px;border:1px solid #cfd8e6;border-radius:4px}',
    '.ai .hint2{color:#8b93a7;margin-top:3px;line-height:1.4}',
    '.btns{display:flex;gap:6px;margin:8px 0 6px}',
    '.btns button{flex:1;padding:5px 0;border-radius:6px;border:1px solid #cfd8e6;background:#fff;cursor:pointer;font-size:12px}',
    '.btns button:hover{background:#f0f4fb}',
    '.btns button:disabled{opacity:.45;cursor:not-allowed}',
    '.btns button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    '.btns button.primary:hover{background:#2a63d4}',
    '.btns button.danger{background:#fff;border-color:#e6b4b1;color:#b3261e}',
    '.toggles{display:flex;gap:10px;align-items:center;margin:6px 0;color:#5b6478;flex-wrap:wrap}',
    '.toggles label{display:flex;gap:4px;align-items:center;cursor:pointer}',
    '.toggles .link{color:#2f6fed;cursor:pointer;text-decoration:underline}',
    '.log{display:none;margin-top:6px;max-height:168px;overflow:auto;background:#0f1420;color:#c8d3e6;',
    'border-radius:6px;padding:6px 7px;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}',
    '.log.show{display:block}',
    '.log .warn{color:#ffd07a}',
    '.log .error{color:#ff9b9b}',
    '.log .debug{color:#8b97ad}',
    '.hint{margin-top:5px;color:#8b93a7;font-size:11px}',
  ].join('');

  const HTML = [
    '<div class="panel" id="panel">',
    '  <div class="head" id="head">',
    '    <span class="title">学习通连播助手</span>',
    '    <span class="badge" id="badge">未启动</span>',
    '    <button class="iconbtn" id="collapse" title="折叠/展开">—</button>',
    '  </div>',
    '  <div class="body">',
    '    <div class="row"><span class="k">课程/节点</span><span class="v" id="job">—</span></div>',
    '    <div class="row"><span class="k">播放状态</span><span class="v" id="play">—</span></div>',
    '    <div class="row"><span class="k">章节进度</span><span class="v" id="chapter">—</span></div>',
    '    <div class="row"><span class="k">已播视频</span><span class="v" id="count">0</span></div>',
    '    <div class="row"><span class="k">平台确认</span><span class="v" id="confirmed">0</span></div>',
    '    <div class="row"><span class="k">待人工确认</span><span class="v" id="pending">0</span></div>',
    '    <div class="row"><span class="k">自动切换</span><span class="v" id="auto">待命</span></div>',
    '    <div class="row"><span class="k">AI 请求</span><span class="v" id="ai">0 次</span></div>',
    '    <div class="err" id="err"></div>',
    '    <div class="note" id="note"></div>',
    '    <div class="await" id="awaitBox">',
    '      <div class="t">视频已播完，平台未确认</div>',
    '      <div class="m" id="awaitMsg"></div>',
    '      <div class="btns">',
    '        <button id="keepWait">继续等待</button>',
    '        <button id="skipRec">跳过并记录</button>',
    '        <button id="stop2" class="danger">停止</button>',
    '      </div>',
    '    </div>',
    '    <div class="quiz" id="quizBox">',
    '      <div class="t" id="quizTitle">检测到弹题</div>',
    '      <div class="stem" id="quizStem"></div>',
    '      <div id="quizOpts"></div>',
    '      <div class="adv" id="quizAdv"></div>',
    '      <div class="btns">',
    '        <button id="qApply">应用建议</button>',
    '        <button id="qSubmit" class="danger">提交</button>',
    '        <button id="qManual">转人工</button>',
    '      </div>',
    '    </div>',
    '    <details class="ai" id="aiBox">',
    '      <summary>AI 设置（弹题用）</summary>',
    '      <div class="f"><label>启用</label><input type="checkbox" id="aiOn" /></div>',
    '      <div class="f"><label>模式</label><select id="aiMode"><option value="proxy">本地代理（推荐）</option><option value="direct">直连</option></select></div>',
    '      <div class="f"><label>代理地址</label><input type="text" id="aiProxyUrl" placeholder="http://127.0.0.1:8787" /></div>',
    '      <div class="f"><label>代理令牌</label><input type="text" id="aiToken" placeholder="代理启动时打印" /></div>',
    '      <div class="f"><label>Base URL</label><input type="text" id="aiBaseUrl" placeholder="https://api.deepseek.com/v1" /></div>',
    '      <div class="f"><label>模型</label><input type="text" id="aiModel" placeholder="deepseek-chat" /></div>',
    '      <div class="f"><label>API Key</label><input type="password" id="aiKey" placeholder="仅存油猴存储" /></div>',
    '      <div class="btns"><button id="aiSave">保存 AI 设置</button></div>',
    '      <div class="hint2" id="aiHint">默认走本地代理，API Key 由代理持有，不进入网页。</div>',
    '    </details>',
    '    <div class="btns">',
    '      <button id="start" class="primary">开始</button>',
    '      <button id="pause">暂停</button>',
    '      <button id="resume">继续</button>',
    '      <button id="stop" class="danger">停止</button>',
    '    </div>',
    '    <div class="toggles">',
    '      <label><input type="checkbox" id="debug" /> 调试日志</label>',
    '      <span class="link" id="diagnose">诊断导出</span>',
    '      <span class="link" id="clearpos">复位面板</span>',
    '    </div>',
    '    <div class="log" id="log"></div>',
    '    <div class="hint" id="hint">1.0 倍速 · 不改进度 · 不绕过检测</div>',
    '  </div>',
    '</div>',
  ].join('');

  let host = null;
  let shadow = null;
  let refs = {};
  let unsubscribe = null;
  let logCount = 0;
  let aiRequests = 0;
  let lastChapterRefresh = 0;
  let chapterText = '—';
  let dragState = null;

  function el(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

  function appendLogRecord(record) {
    const box = el('log');
    if (!box) return;
    logCount++;
    if (logCount > 200) {
      box.removeChild(box.firstChild);
    }
    const line = document.createElement('div');
    line.className = record.level;
    line.textContent = record.time + ' ' + record.message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function refreshLog() {
    const box = el('log');
    if (!box) return;
    box.textContent = '';
    logCount = 0;
    for (const record of Log.recent(120)) appendLogRecord(record);
  }

  function setBadge(text, kind) {
    const badge = el('badge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'badge ' + (kind || '');
  }

  function update(snapshot) {
    if (!snapshot || !shadow) return;

    const label = snapshot.stateLabel || snapshot.state || '—';
    setBadge(label, snapshot.state);

    const jobText = snapshot.jobTitle
      ? snapshot.jobTitle + (snapshot.jobType ? '（' + snapshot.jobType + '）' : '')
      : '—';
    if (refs.job) refs.job.textContent = jobText;

    const video = snapshot.video;
    let playText = '—';
    if (video) {
      const cur = video.currentTime || 0;
      const dur = video.duration || 0;
      playText =
        (video.ended ? '已结束' : video.paused ? '暂停' : '播放中') +
        ' · ' +
        (Number(video.playbackRate) || 1) +
        'x · ' +
        (dur > 0 ? fmtTime(cur) + '/' + fmtTime(dur) : fmtTime(cur));
    }
    if (refs.play) refs.play.textContent = playText;

    if (refs.count) refs.count.textContent = String(snapshot.playedCount || 0);
    if (refs.confirmed) refs.confirmed.textContent = String(snapshot.confirmedCount || 0);
    if (refs.pending) refs.pending.textContent = String(snapshot.pendingCount || 0);
    if (refs.ai) refs.ai.textContent = aiRequests + ' 次';

    // awaitingConfirm 的专用操作区
    const awaiting = snapshot.state === 'awaitingConfirm';
    if (refs.awaitBox) refs.awaitBox.classList.toggle('show', awaiting);
    if (awaiting && refs.awaitMsg) {
      const waitedSec = snapshot.awaitingSince ? Math.round((Date.now() - snapshot.awaitingSince) / 1000) : 0;
      refs.awaitMsg.textContent =
        (snapshot.jobTitle ? '任务：' + snapshot.jobTitle + '；' : '') +
        '已等待 ' + waitedSec + ' 秒，平台仍未标记完成。已尝试等待 ' +
        (snapshot.awaitingTries || 0) + ' 次。跳过不计入完成。';
    }

    // 完成度说明（视频完成 ≠ 整门课程完成）
    if (refs.note) {
      let noteText = '';
      const completion = snapshot.completion;
      if (snapshot.state === 'completed' && completion) {
        noteText = '视频任务已全部得到平台确认';
        if (completion.pendingOthers && completion.pendingOthers > 0) {
          noteText += '；但仍有 ' + completion.pendingOthers + ' 个非视频任务（如章节测验）未处理，整门课程尚未完成';
        }
      } else if (snapshot.state === 'needsReview' && completion && completion.reasons.length) {
        noteText = '无法确认完成：' + completion.reasons.join('；');
      }
      refs.note.textContent = noteText;
      refs.note.classList.toggle('show', !!noteText);
    }

    if (refs.auto) {
      if (snapshot.state === 'blocked') refs.auto.textContent = '已停止（需人工）';
      else if (snapshot.state === 'paused') refs.auto.textContent = '已暂停';
      else if (snapshot.state === 'completed') refs.auto.textContent = '课程完成';
      else if (snapshot.state === 'stopped') refs.auto.textContent = '已停止';
      else if (snapshot.running) refs.auto.textContent = '自动切换中';
      else refs.auto.textContent = '待命';
    }

    if (refs.err) {
      if (snapshot.lastError) {
        refs.err.textContent = '最近错误：' + snapshot.lastError;
        refs.err.classList.add('show');
      } else {
        refs.err.textContent = '';
        refs.err.classList.remove('show');
      }
    }

    const state = snapshot.state;
    if (refs.start) refs.start.disabled = snapshot.running || state === 'playing';
    if (refs.pause) refs.pause.disabled = !snapshot.running;
    // quizWait 也要能点「继续」：那是结束弹题并交还播放的出口
    if (refs.resume) refs.resume.disabled = state !== 'paused' && state !== 'quizWait';
    if (refs.stop) refs.stop.disabled = state === 'stopped' || state === 'completed';

    // 章节进度：节流刷新，避免高频读取 DOM
    const now = Date.now();
    if (now - lastChapterRefresh > 2500) {
      lastChapterRefresh = now;
      refreshChapter();
    }

    renderQuiz(snapshot.quiz, state);
  }

  function refreshChapter() {
    if (!refs.chapter) return;
    try {
      const catalog = CourseTree.catalogEntries();
      if (!catalog.items.length) {
        refs.chapter.textContent = '未识别目录';
        return;
      }
      let activeIndex = -1;
      for (let i = 0; i < catalog.items.length; i++) {
        const node = catalog.items[i];
        const active =
          (node.classList && node.classList.contains(SEL.catalogActiveClass)) ||
          !!node.querySelector('.' + SEL.catalogActiveClass);
        if (active) {
          activeIndex = i;
          break;
        }
      }
      chapterText =
        activeIndex >= 0
          ? '第 ' + (activeIndex + 1) + ' / ' + catalog.items.length + ' 节'
          : '共 ' + catalog.items.length + ' 节（未定位当前）';
      refs.chapter.textContent = chapterText;
    } catch (e) {
      refs.chapter.textContent = '读取失败';
    }
  }

  function fmtTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // 弹题卡片（阶段 D1）
  function renderQuiz(quiz, state) {
    if (!refs.quizBox) return;
    const show = state === 'quizWait' && quiz && quiz.phase && quiz.phase !== 'idle';
    refs.quizBox.classList.toggle('show', !!show);
    if (!show) return;

    const question = quiz.question;
    if (refs.quizTitle) {
      refs.quizTitle.textContent = question
        ? '检测到弹题 · ' + (question.typeLabel || '')
        : '弹题处理中';
    }
    if (refs.quizStem) {
      refs.quizStem.textContent = question ? question.stem : quiz.error || '';
    }

    if (refs.quizOpts) {
      refs.quizOpts.textContent = '';
      if (question) {
        const pick = new Set((quiz.suggestion && quiz.suggestion.letters) || []);
        for (const option of question.options) {
          const row = document.createElement('div');
          row.className = 'opt' + (pick.has(option.letter) ? ' pick' : '');
          row.textContent =
            option.letter + '. ' + option.text + (pick.has(option.letter) ? '   ← 建议' : '');
          refs.quizOpts.appendChild(row);
        }
      }
    }

    if (refs.quizAdv) {
      const lines = [];
      const suggestion = quiz.suggestion;
      if (suggestion) {
        lines.push(
          '建议：' + suggestion.letters.join(',') +
            '（置信度 ' + Math.round((suggestion.confidence || 0) * 100) + '%）'
        );
        if (suggestion.reason) lines.push('理由：' + suggestion.reason);
        if (suggestion.uncertain) lines.push('⚠ 模型自述不确定，请人工核对后再提交');
      }
      if (quiz.error) lines.push('⚠ ' + quiz.error);
      const ai = quiz.ai;
      if (ai) {
        lines.push(
          'AI 请求 ' + ai.requests + ' 次 / 失败 ' + ai.failures +
            ' / token ' + (ai.promptTokens + ai.completionTokens)
        );
      }
      refs.quizAdv.textContent = lines.join('\n');
    }

    if (refs.qApply) refs.qApply.disabled = !quiz.suggestion;
    if (refs.qSubmit) refs.qSubmit.disabled = !question || quiz.submitted === true;
  }

  function applyPosition() {
    const panel = el('panel');
    if (!panel) return;
    const pos = Config.get('panelPos');
    if (pos && typeof pos.right === 'number' && typeof pos.top === 'number') {
      panel.style.right = Math.max(0, pos.right) + 'px';
      panel.style.top = Math.max(0, pos.top) + 'px';
    }
  }

  // AI 设置（阶段 D1）
  function initAiSettings() {
    if (!refs.aiOn) return;

    refs.aiOn.checked = Config.get('llmEnabled') === true;
    refs.aiMode.value = Config.get('llmMode') === 'direct' ? 'direct' : 'proxy';
    refs.aiProxyUrl.value = Config.get('llmProxyUrl') || '';
    refs.aiToken.value = Config.get('llmProxyToken') || '';
    refs.aiBaseUrl.value = Config.get('llmBaseUrl') || '';
    refs.aiModel.value = Config.get('llmModel') || '';

    if (refs.aiHint) {
      refs.aiHint.textContent = Config.hasGM()
        ? '默认走本地代理：API Key 由代理持有，不进入网页。直连模式需自己在脚本头追加 @connect。'
        : '当前没有油猴存储：禁止保存 API Key，只能用本地代理模式。';
    }

    refs.aiOn.addEventListener('change', function () {
      Config.set('llmEnabled', refs.aiOn.checked === true);
      Log.info('AI 弹题：' + (refs.aiOn.checked ? '已开启' : '已关闭'));
    });

    if (refs.aiSave) {
      refs.aiSave.addEventListener('click', function () {
        Config.set('llmMode', refs.aiMode.value === 'direct' ? 'direct' : 'proxy');
        Config.set('llmProxyUrl', refs.aiProxyUrl.value.trim());
        Config.set('llmProxyToken', refs.aiToken.value.trim());
        Config.set('llmBaseUrl', refs.aiBaseUrl.value.trim());
        Config.set('llmModel', refs.aiModel.value.trim());
        const key = refs.aiKey.value.trim();
        if (key && !Config.set('llmApiKey', key)) {
          Log.warn('API Key 未保存：请改用本地代理模式');
        }
        Log.info('AI 设置已保存（模式：' + Config.get('llmMode') + '）');
      });
    }
  }

  function bindDrag() {    const head = el('head');
    const panel = el('panel');
    if (!head || !panel) return;

    head.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      event.preventDefault();
    });

    window.addEventListener('mousemove', function (event) {
      if (!dragState) return;
      const rect = panel.getBoundingClientRect();
      const width = rect.width || 296;
      const height = rect.height || 200;
      let left = event.clientX - dragState.offsetX;
      let top = event.clientY - dragState.offsetY;
      left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - height - 4));
      panel.style.right = Math.max(4, window.innerWidth - left - width) + 'px';
      panel.style.top = top + 'px';
    });

    window.addEventListener('mouseup', function () {
      if (!dragState) return;
      dragState = null;
      const rect = panel.getBoundingClientRect();
      Config.set('panelPos', {
        right: Math.round(Math.max(0, window.innerWidth - rect.right)),
        top: Math.round(Math.max(0, rect.top)),
      });
    });
  }

  function showDiagnose() {
    let data = null;
    try {
      data = Runner.diagnose();
    } catch (e) {
      Log.error('诊断失败：' + (e && e.message));
      return;
    }
    const text = JSON.stringify(data, null, 2);
    // 打印到控制台，并尝试复制到剪贴板，便于贴给我做选择器适配
    console.log('[课程伴学工具] 诊断导出\n' + text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            Log.info('诊断信息已复制到剪贴板，可直接粘贴');
          },
          function () {
            Log.warn('复制失败，请从控制台复制诊断 JSON');
          }
        );
      } else {
        Log.warn('剪贴板不可用，请从控制台复制诊断 JSON');
      }
    } catch (e) {
      Log.warn('复制异常，请从控制台复制诊断 JSON');
    }
    const box = el('log');
    if (box) {
      box.classList.add('show');
      box.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…（完整内容见控制台）' : text;
    }
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'cx-natural-watch-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = HTML;
    while (wrapper.firstChild) shadow.appendChild(wrapper.firstChild);

    refs = {
      job: el('job'),
      play: el('play'),
      chapter: el('chapter'),
      count: el('count'),
      confirmed: el('confirmed'),
      pending: el('pending'),
      auto: el('auto'),
      ai: el('ai'),
      err: el('err'),
      note: el('note'),
      awaitBox: el('awaitBox'),
      awaitMsg: el('awaitMsg'),
      keepWait: el('keepWait'),
      skipRec: el('skipRec'),
      stop2: el('stop2'),
      quizBox: el('quizBox'),
      quizTitle: el('quizTitle'),
      quizStem: el('quizStem'),
      quizOpts: el('quizOpts'),
      quizAdv: el('quizAdv'),
      qApply: el('qApply'),
      qSubmit: el('qSubmit'),
      qManual: el('qManual'),
      aiOn: el('aiOn'),
      aiMode: el('aiMode'),
      aiProxyUrl: el('aiProxyUrl'),
      aiToken: el('aiToken'),
      aiBaseUrl: el('aiBaseUrl'),
      aiModel: el('aiModel'),
      aiKey: el('aiKey'),
      aiSave: el('aiSave'),
      aiHint: el('aiHint'),
      start: el('start'),
      pause: el('pause'),
      resume: el('resume'),
      stop: el('stop'),
      debug: el('debug'),
      log: el('log'),
    };

    applyPosition();
    if (Config.get('panelCollapsed')) el('panel').classList.add('collapsed');

    el('start').addEventListener('click', function () {
      Runner.start();
    });
    el('pause').addEventListener('click', function () {
      Runner.pause();
    });
    el('resume').addEventListener('click', function () {
      Runner.resume();
    });
    el('stop').addEventListener('click', function () {
      Runner.stop();
    });

    if (refs.keepWait) {
      refs.keepWait.addEventListener('click', function () {
        Runner.keepWaiting();
      });
    }
    if (refs.skipRec) {
      refs.skipRec.addEventListener('click', function () {
        Runner.skipAwaiting();
      });
    }
    if (refs.stop2) {
      refs.stop2.addEventListener('click', function () {
        Runner.stop();
      });
    }

    // ---- 弹题操作 ----
    if (refs.qApply) {
      refs.qApply.addEventListener('click', function () {
        Runner.applyQuizSuggestion();
      });
    }
    if (refs.qSubmit) {
      refs.qSubmit.addEventListener('click', function () {
        // 提交有副作用：必须再确认一次
        let confirmed = true;
        try {
          if (typeof window.confirm === 'function') {
            confirmed = window.confirm('确认提交该题答案？提交后由平台判定。');
          }
        } catch (e) {
          confirmed = true;
        }
        if (confirmed) Runner.submitQuiz();
      });
    }
    if (refs.qManual) {
      refs.qManual.addEventListener('click', function () {
        Runner.dismissQuiz();
      });
    }

    initAiSettings();

    el('collapse').addEventListener('click', function () {
      const panel = el('panel');
      panel.classList.toggle('collapsed');
      Config.set('panelCollapsed', panel.classList.contains('collapsed'));
    });

    if (refs.debug) {
      refs.debug.checked = Config.get('debugLog') === true;
      refs.debug.addEventListener('change', function () {
        Config.set('debugLog', refs.debug.checked === true);
        Log.info('调试日志：' + (refs.debug.checked ? '已开启' : '已关闭'));
      });
    }

    el('diagnose').addEventListener('click', showDiagnose);
    el('clearpos').addEventListener('click', function () {
      Config.set('panelPos', null);
      const panel = el('panel');
      panel.style.right = '14px';
      panel.style.top = '14px';
      Log.info('面板位置已复位');
    });

    // 日志开关：调试日志按钮同时控制日志区显示
    if (refs.debug) {
      refs.debug.addEventListener('change', function () {
        if (refs.log) refs.log.classList.toggle('show', refs.debug.checked === true);
      });
      if (refs.log) refs.log.classList.toggle('show', refs.debug.checked === true);
    }

    bindDrag();
    refreshLog();
    unsubscribe = Log.subscribe(appendLogRecord);

    (document.body || document.documentElement).appendChild(host);
    Log.info('面板已挂载');
  }

  return {
    mount,
    update,
    setAiRequests(count) {
      aiRequests = Number(count) || 0;
      if (refs.ai) refs.ai.textContent = aiRequests + ' 次';
    },
    unmount() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      shadow = null;
    },
    element() {
      return host;
    },
  };
})();

// ===========================================================================
// 91-quiz-image.js
// ===========================================================================
// ---------------------------------------------------------------------------
// quiz-image.js —— 题目图像提取（阶段 D2 视觉链路）
//
// 为什么不用 DOM 截图或 foreignObject：
//   - 用户脚本无法截屏；
//   - foreignObject 需要把内联 base64 字体再塞进 SVG，体积与兼容性都不可控。
// 采用 Canvas 直接绘制文本，字体沿用页面已加载的 font-cxsecret：
//   实测该字体渲染加密字符时显示的是正确汉字，所以 Canvas 用同一字体也能得到正确字形。
//
// 重要限制（用户明确要求不能假设 DOM 都渲染正确）：
//   - 只绘制我们显式提取并排版的文本（题干 + 选项），不克隆原 DOM
//   - 题目内含图片/公式/img 时标记 unsupported，不假装能正确渲染
//   - 高度超过上限标记 tooTall，交由调用方分段
//
// 输出：{ ok, dataUrl, width, height, unsupported, encrypted }
// ---------------------------------------------------------------------------
const QuizImage = (function () {
  const WIDTH = 900;
  const PADDING = 24;
  const FONT_SIZE = 22;
  const LINE_HEIGHT = 34;
  const OPTION_GAP = 6;
  const MAX_HEIGHT = 4000;
  const MAX_WIDTH = 4096;

  const ENCRYPTED_FONT = '"font-cxsecret", "Microsoft YaHei", sans-serif';
  const PLAIN_FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

  function fontFor(encrypted) {
    return '400 ' + FONT_SIZE + 'px ' + (encrypted ? ENCRYPTED_FONT : PLAIN_FONT);
  }

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const ch of String(text || '')) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  // 检测题目里是否含我们无法可靠绘制的元素
  function detectUnsupported(questionEl) {
    const unsupported = [];
    if (!questionEl) return unsupported;
    try {
      if (questionEl.querySelector('img, svg, video, canvas, iframe')) {
        unsupported.push('image-or-formula');
      }
      // MathJax / KaTeX 公式容器
      if (questionEl.querySelector('.MathJax, .katex, mjx-container, math')) {
        unsupported.push('math');
      }
    } catch (e) {
      /* ignore */
    }
    return unsupported;
  }

  /**
   * 把一道题渲染成 PNG dataURL。
   * @param {object} question ChapterQuizAdapter.parse 出来的单题
   * @param {object} options { scale:number }
   */
  function render(question, options) {
    const opts = options || {};
    if (!question) return { ok: false, reason: 'no-question' };

    const scale = Number(opts.scale) || 2; // 2x 提升识别精度
    const unsupported = detectUnsupported(question.el);
    const encrypted = !!question.encrypted;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'no-2d-context' };

    ctx.font = fontFor(encrypted);
    const textWidth = WIDTH - PADDING * 2;

    const blocks = [];
    // 标题行
    blocks.push({ kind: 'title', text: '第 ' + (question.num || '?') + ' 题 ' + (question.typeLabel || '') });
    // 题干
    for (const line of wrapText(ctx, question.stem, textWidth)) {
      blocks.push({ kind: 'stem', text: line });
    }
    blocks.push({ kind: 'gap', text: '' });
    // 选项
    for (const option of question.options) {
      const prefix = (option.letter || '?') + '  ';
      const wrapped = wrapText(ctx, prefix + option.text, textWidth);
      for (let i = 0; i < wrapped.length; i++) {
        blocks.push({ kind: i === 0 ? 'option' : 'option-cont', text: wrapped[i] });
      }
    }

    // 计算高度
    let height = PADDING;
    for (const block of blocks) {
      height += block.kind === 'gap' ? 12 : LINE_HEIGHT;
      if (block.kind === 'option') height += OPTION_GAP;
    }
    height += PADDING;

    if (height > MAX_HEIGHT) {
      return { ok: false, reason: 'tooTall', height: height, unsupported: unsupported };
    }
    if (WIDTH * scale > MAX_WIDTH) {
      return { ok: false, reason: 'tooWide', unsupported: unsupported };
    }

    canvas.width = WIDTH * scale;
    canvas.height = height * scale;
    ctx.scale(scale, scale);

    // 白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, height);
    ctx.fillStyle = '#111111';
    ctx.textBaseline = 'top';

    let y = PADDING;
    for (const block of blocks) {
      if (block.kind === 'gap') {
        y += 12;
        continue;
      }
      if (block.kind === 'title') {
        ctx.font = '600 ' + (FONT_SIZE - 2) + 'px ' + (encrypted ? ENCRYPTED_FONT : PLAIN_FONT);
        ctx.fillStyle = '#444444';
      } else if (block.kind === 'stem') {
        ctx.font = fontFor(encrypted);
        ctx.fillStyle = '#111111';
      } else {
        ctx.font = fontFor(encrypted);
        ctx.fillStyle = '#1f2430';
        if (block.kind === 'option') y += OPTION_GAP;
      }
      ctx.fillText(block.text, PADDING, y);
      y += LINE_HEIGHT;
    }

    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (e) {
      return { ok: false, reason: 'toDataUrl-failed', unsupported: unsupported };
    }

    return {
      ok: true,
      dataUrl: dataUrl,
      width: WIDTH * scale,
      height: height * scale,
      encrypted: encrypted,
      unsupported: unsupported,
      bytes: Math.round((dataUrl.length * 3) / 4),
    };
  }

  /**
   * 逐题渲染，返回数组；单题失败不影响其他题。
   */
  function renderAll(quiz, options) {
    const results = [];
    const questions = (quiz && quiz.questions) || [];
    for (const question of questions) {
      let result;
      try {
        result = render(question, options);
      } catch (e) {
        result = { ok: false, reason: 'render-error: ' + (e && e.message) };
      }
      results.push({
        key: question.key,
        num: question.num,
        type: question.type,
        rendered: result,
      });
    }
    return results;
  }

  return {
    render,
    renderAll,
    detectUnsupported,
    constants: { WIDTH, PADDING, FONT_SIZE, LINE_HEIGHT, MAX_HEIGHT, MAX_WIDTH },
  };
})();

// ===========================================================================
// 92-quiz-vision-client.js
// ===========================================================================
// ---------------------------------------------------------------------------
// quiz-vision-client.js —— 浏览器端调用本地视觉桥接
//
// 只走 GM_xmlhttpRequest（与 D1 的 Llm 保持同一原则，不用页面 fetch）。
// 桥接地址与令牌来自配置，默认 http://127.0.0.1:8788。
//
// 每次请求携带：
//   questionId     由 DOM 侧维护的稳定题目 ID（不是视觉推测的题号）
//   allowedLetters 页面实际存在的选项字母（用于服务端与客户端双重校验）
//   imageBase64    Canvas 渲染出的 PNG dataURL
// ---------------------------------------------------------------------------
const QuizVision = (function () {
  const STATS = { requests: 0, successes: 0, failures: 0, lastError: '', lastElapsedMs: 0 };

  let busy = false;

  function readConfig() {
    return {
      enabled: !!window.__cxHost || Config.get('visionEnabled') === true,
      url: String(Config.get('visionBridgeUrl') || 'http://127.0.0.1:8788').replace(/\/+$/, ''),
      token: String(Config.get('visionBridgeToken') || ''),
      timeoutMs: Number(Config.get('visionTimeoutMs')) || 130000,
    };
  }

  function stats() {
    return Object.assign({}, STATS);
  }

  function gmPost(url, headers, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用'));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          headers: headers,
          data: body,
          timeout: timeoutMs,
          onload: function (res) {
            resolve({ status: res.status, text: String(res.responseText || '') });
          },
          onerror: function () {
            reject(new Error('网络错误：桥接服务是否在运行？'));
          },
          ontimeout: function () {
            reject(new Error('请求超时'));
          },
          onabort: function () {
            reject(new Error('请求已取消'));
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 请求视觉作答。
   * @param {string} imageDataUrl Canvas 生成的 PNG dataURL
   * @param {string} questionId 稳定题目 ID
   * @param {string[]} allowedLetters 页面实际选项字母
   */
  async function ask(imageDataUrl, questionId, allowedLetters) {
    const cfg = readConfig();
    if (!cfg.enabled) return { ok: false, error: '视觉识别未开启', answers: [], status: 'unreadable' };
    if (!imageDataUrl) return { ok: false, error: '没有图片', answers: [], status: 'unreadable' };
    if (busy) return { ok: false, error: '上一个视觉请求仍在进行', answers: [], status: 'unreadable' };

    busy = true;
    STATS.requests++;
    const started = Date.now();

    try {
      const body = JSON.stringify({
        questionId: questionId,
        imageBase64: imageDataUrl,
        allowedLetters: allowedLetters || [],
      });

      // Desktop uses its built-in host, not the optional Tampermonkey HTTP bridge.
      const nativeResult = window.__cxHost ? await window.__cxHost.askVision({ questionId, imageBase64: imageDataUrl, allowedLetters: allowedLetters || [] }) : null;
      const res = nativeResult ? { status: 200, text: JSON.stringify(nativeResult) } : await gmPost(
        cfg.url + '/vision',
        { 'Content-Type': 'application/json', 'X-Vision-Token': cfg.token },
        body,
        cfg.timeoutMs
      );

      STATS.lastElapsedMs = Date.now() - started;

      let data = null;
      try {
        data = JSON.parse(res.text);
      } catch (e) {
        STATS.failures++;
        STATS.lastError = '桥接返回非 JSON（HTTP ' + res.status + '）';
        return { ok: false, error: STATS.lastError, answers: [], status: 'unreadable' };
      }

      if (res.status !== 200) {
        STATS.failures++;
        STATS.lastError = (data && data.error) || 'HTTP ' + res.status;
        return {
          ok: false,
          error: STATS.lastError,
          answers: [],
          status: 'unreadable',
          httpStatus: res.status,
        };
      }

      // 客户端二次校验：题目 ID 必须回显一致，选项必须在允许集合内
      const errors = [];
      if (String(data.questionId || '') !== String(questionId)) {
        errors.push('questionId 不一致');
      }
      const allowed = new Set((allowedLetters || []).map(function (l) { return String(l).toUpperCase(); }));
      let answers = Array.isArray(data.answers) ? data.answers.map(function (a) { return String(a).toUpperCase(); }) : [];
      if (allowed.size) {
        const bad = answers.filter(function (a) { return !allowed.has(a); });
        if (bad.length) errors.push('选项不存在：' + bad.join(','));
        answers = answers.filter(function (a) { return allowed.has(a); });
      }

      if (errors.length) {
        STATS.failures++;
        STATS.lastError = errors.join('；');
        return { ok: false, error: STATS.lastError, answers: answers, status: 'unreadable' };
      }

      const ok = data.ok === true && data.status === 'ok';
      if (ok) STATS.successes++;
      else {
        STATS.failures++;
        STATS.lastError = data.status || '未识别';
      }

      return {
        ok: ok,
        status: data.status || 'unreadable',
        type: data.type || 'unknown',
        answers: answers,
        errors: data.errors || [],
        elapsedMs: data.elapsedMs || STATS.lastElapsedMs,
      };
    } catch (error) {
      STATS.failures++;
      STATS.lastError = (error && error.message) || '请求失败';
      return { ok: false, error: STATS.lastError, answers: [], status: 'unreadable' };
    } finally {
      busy = false;
    }
  }

  async function health() {
    const cfg = readConfig();
    try {
      if (window.__cxHost) {
        const data = await window.__cxHost.visionStatus();
        return { ok: data.dshFound && data.hasKey, data };
      }
      const res = await new Promise(function (resolve, reject) {
        if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no GM'));
        GM_xmlhttpRequest({
          method: 'GET',
          url: cfg.url + '/health',
          timeout: 5000,
          onload: function (r) {
            resolve({ status: r.status, text: String(r.responseText || '') });
          },
          onerror: function () {
            reject(new Error('连接失败'));
          },
          ontimeout: function () {
            reject(new Error('超时'));
          },
        });
      });
      const data = JSON.parse(res.text);
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'unknown' };
    }
  }

  return {
    ask,
    health,
    stats,
    readConfig,
    isBusy() {
      return busy;
    },
  };
})();

// ===========================================================================
// 99-main.js
// ===========================================================================
// ---------------------------------------------------------------------------
// main.js —— 入口装配
// 只在确认可运行的学习页挂载；重复注入时先销毁旧实例。
// URL 判定统一走 CourseUrl（P0-1），不再各写一份正则。
// ---------------------------------------------------------------------------
const APP_KEY = '__cxNaturalWatchApp';

function destroyPrevious() {
  const previous = window[APP_KEY];
  if (previous && typeof previous.destroy === 'function') {
    try {
      previous.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  window[APP_KEY] = null;
}

function boot() {
  destroyPrevious();

  Config.load();
  Runner.setHooks({ onUpdate: UI.update });
  UI.mount();

  window[APP_KEY] = {
    destroy: function () {
      try {
        Runner.stop();
      } catch (e) {
        /* ignore */
      }
      UI.unmount();
    },
    runner: Runner,
    ui: UI,
    config: Config,
    log: Log,
    tree: CourseTree,
    urls: CourseUrl,
    diagnose: function () {
      return Runner.diagnose();
    },
  };

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('开始连播', function () {
      Runner.start();
    });
    GM_registerMenuCommand('暂停', function () {
      Runner.pause();
    });
    GM_registerMenuCommand('继续', function () {
      Runner.resume();
    });
    GM_registerMenuCommand('停止', function () {
      Runner.stop();
    });
    GM_registerMenuCommand('诊断导出（复制到剪贴板）', function () {
      const data = Runner.diagnose();
      const text = JSON.stringify(data, null, 2);
      console.log('[课程伴学工具] 诊断导出\n' + text);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            Log.info('诊断信息已复制');
          },
          function () {
            Log.warn('复制失败，请从控制台复制');
          }
        );
      }
    });
  }

  Log.info('已就绪：' + location.pathname);

  const cursor = Config.readCursor();
  if (cursor && cursor.jobTitle) {
    Log.info('上次记录停留在：' + cursor.jobTitle + '（仅用于提示，是否完成以平台为准）');
  }

  if (Config.get('autoStart') === true) {
    Log.info('autoStart 已开启，等课程容器就绪后自动开始');
    waitForCourseShell(15000).then(function (ready) {
      if (!ready) {
        Log.warn('等待课程容器超时，未自动开始');
        return;
      }
      if (Runner.state() === 'idle' || Runner.state() === 'stopped') Runner.start();
    });
  }
}

// 等课程壳子出现（#coursetree 或首个任务点容器），最多 timeoutMs
function waitForCourseShell(timeoutMs) {
  return new Promise(function (resolve) {
    const startedAt = Date.now();
    let timer = null;

    function check() {
      let ok = false;
      try {
        ok =
          !!document.querySelector('#coursetree') ||
          !!document.querySelector('.posCatalog_level') ||
          !!document.querySelector('.ans-attach-ct') ||
          !!document.querySelector('.ans-job-icon');
      } catch (e) {
        ok = false;
      }
      if (ok) {
        finish(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      timer = setTimeout(check, 800);
    }

    function finish(result) {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(result);
    }

    check();
  });
}

// 统一入口判定：
//   - 视频学习页：只在顶层挂载（避免 iframe 内重复面板）
//   - 章节测验页：实测位于 #frame_content-zj 内，必须允许在 iframe 中挂载
const IS_TOP_FRAME = (function () {
  try {
    return window.top === window.self;
  } catch (e) {
    return false;
  }
})();

function isQuizPageHere() {
  if (typeof ChapterQuizAdapter === 'undefined') return false;
  try {
    return ChapterQuizAdapter.detect(document).isQuizPage;
  } catch (e) {
    return false;
  }
}

function bootQuizPage() {
  Config.load();
  QuizPanel.mount();
  window[APP_KEY] = {
    destroy: function () {
      try {
        ChapterQuizRunner.stop();
      } catch (e) {
        /* ignore */
      }
      QuizPanel.unmount();
    },
    adapter: ChapterQuizAdapter,
    runner: ChapterQuizRunner,
    panel: QuizPanel,
    config: Config,
    log: Log,
  };
  Log.info('章节测验面板已就绪：' + location.pathname);
}

if (IS_TOP_FRAME && CourseUrl.isStudyPage(location.href)) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
} else if (isQuizPageHere()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootQuizPage, { once: true });
  } else {
    bootQuizPage();
  }
}

// 供控制台验收使用（任何页面都可访问，只读）
if (typeof ChapterQuizAdapter !== 'undefined') {
  window.__cxChapterQuiz = {
    adapter: ChapterQuizAdapter,
    runner: ChapterQuizRunner,
    config: typeof Config !== 'undefined' ? Config : null,
    image: typeof QuizImage !== 'undefined' ? QuizImage : null,
    vision: typeof QuizVision !== 'undefined' ? QuizVision : null,
    detect: function () {
      return ChapterQuizAdapter.detect(document);
    },
    parse: function () {
      return ChapterQuizAdapter.parse(document);
    },
    renderOne: function (index) {
      if (typeof QuizImage === 'undefined') return { ok: false, reason: 'no-image-module' };
      const quiz = ChapterQuizAdapter.parse(document);
      const q = quiz.questions[index || 0];
      if (!q) return { ok: false, reason: 'no-question' };
      return QuizImage.render(q);
    },
  };
}

})();
