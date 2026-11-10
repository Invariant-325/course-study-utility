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
