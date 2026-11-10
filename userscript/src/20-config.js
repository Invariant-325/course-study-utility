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
