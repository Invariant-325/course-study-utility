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
