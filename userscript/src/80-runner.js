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
