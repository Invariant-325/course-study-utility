// ---------------------------------------------------------------------------
// main.js —— 入口装配
// 只在确认可运行的学习页挂载；重复注入时先销毁旧实例。
// URL 判定统一走 CourseUrl（P0-1），不再各写一份正则。
// ---------------------------------------------------------------------------
const APP_KEY = '__cxNaturalWatchApp';

// App（Electron 桌面版）内部注入时，宿主会先把 __CX_IN_APP__ 置为 true。
// App 自己有侧栏界面，网页里再挂一套面板既重复又挡内容，所以这时不挂 UI，
// 但仍保留 Runner / Config / ChapterQuiz 等全部逻辑供宿主调用。
const IN_APP = (function () {
  try {
    return window.__CX_IN_APP__ === true;
  } catch (e) {
    return false;
  }
})();

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
  // App 内不挂网页面板，避免和宿主的侧栏重复
  if (!IN_APP) UI.mount();

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
  // 同上：App 内由宿主侧栏负责答题交互，网页里不再挂测验面板
  if (!IN_APP) QuizPanel.mount();
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
  Log.info(IN_APP ? '章节测验逻辑已就绪（App 模式，不挂网页面板）' : '章节测验面板已就绪：' + location.pathname);
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
