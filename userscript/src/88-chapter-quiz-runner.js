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
        if (!window.__cxHost&&typeof QuizImage === 'undefined') {
          S.suggestions[q.key] = { status: 'skip', error: '图像模块未加载' };
          continue;
        }

        if (quizDoc.fonts && quizDoc.fonts.ready) await quizDoc.fonts.ready;
        const image=window.__cxHost?await window.__cxHost.captureQuestion?.({questionId:q.key})||{ok:false,reason:'桌面截图接口未就绪'}:QuizImage.render(q);
        if(token!==S.token)return false;
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
        let result = await QuizVision.ask(image.dataUrl, q.key, letters);
        if (token !== S.token) return false;
        // A fresh, wider browser render can resolve clipped or overly dense captures.
        // Never retry an explicitly uncertain answer or reuse a result after cancellation.
        if (window.__cxHost && !result.ok && ['unrecognized', 'unreadable'].includes(result.status) && !/HTTP|NETWORK|KEY|401|403|超时|网络|密钥|配置/i.test(result.error||'')) {
          const retryImage = await window.__cxHost.captureQuestion?.({questionId:q.key,minWidth:1600});
          if (token !== S.token) return false;
          if (retryImage?.ok) {
            result = await QuizVision.ask(retryImage.dataUrl, q.key, letters);
            if (token !== S.token) return false;
          }
        }

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
      const failures=Object.values(S.suggestions).map(s=>s?.error).filter(Boolean);
      return {ok:false,phase:'analyze',error:failures.length?[...new Set(failures)].slice(0,3).join('；'):'未获得可用答案'};
    }

    if(answered.length!==S.quiz.questions.length){
      const failed=S.quiz.questions.filter(q=>S.suggestions[q.key]?.status!=='ok').map(q=>'第 '+q.num+' 题：'+(S.suggestions[q.key]?.error||'未获得答案'));
      return {ok:false,phase:'analyze',error:failed.slice(0,3).join('；')+'；未填写或提交本章答案',answered:answered.length,total:S.quiz.questions.length};
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
