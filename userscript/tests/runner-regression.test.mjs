import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const FILES = [
  '10-log.js',
  '20-config.js',
  '30-selectors.js',
  '35-urls.js',
  '40-dom.js',
  '50-course-tree.js',
  '60-video.js',
  '65-pause.js',
  '70-state.js',
  '80-runner.js',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(html) {
  return loadEnv(FILES, { html: '<!doctype html><html><body>' + (html || '') + '</body></html>' });
}

function jobHtml(state) {
  const label = state === 'finished' ? '任务点已完成' : state === 'unfinished' ? '任务点未完成' : '';
  const cls = state === 'finished' ? 'ans-job ans-job-finished' : 'ans-job';
  const attr = label ? ' aria-label="' + label + '"' : '';
  return (
    '<div class="' + cls + '">' +
    '<span class="ans-job-icon"' + attr + '></span>' +
    '<iframe src="/ananas/modules/video/index.html"></iframe>' +
    '</div>'
  );
}

// 可控 video：能统计监听器数量，能手动触发事件
function installVideo(container, options) {
  const opts = options || {};
  const doc = container.ownerDocument;
  const video = doc.createElement('video');
  video.id = 'video_html5_api';
  container.appendChild(video);

  const state = {
    paused: true,
    ended: false,
    currentTime: opts.startTime || 0,
    duration: opts.duration || 100,
    readyState: opts.readyState === undefined ? 4 : opts.readyState,
    networkState: opts.networkState === undefined ? 1 : opts.networkState,
  };
  const counts = {};

  const origAdd = video.addEventListener.bind(video);
  const origRemove = video.removeEventListener.bind(video);
  video.addEventListener = function (type, fn, o) {
    counts[type] = (counts[type] || 0) + 1;
    return origAdd(type, fn, o);
  };
  video.removeEventListener = function (type, fn, o) {
    counts[type] = (counts[type] || 0) - 1;
    return origRemove(type, fn, o);
  };

  video.play = function () {
    state.paused = false;
    return Promise.resolve();
  };
  video.pause = function () {
    state.paused = true;
  };
  Object.defineProperty(video, 'paused', { get: () => state.paused, configurable: true });
  Object.defineProperty(video, 'ended', { get: () => state.ended, configurable: true });
  Object.defineProperty(video, 'currentTime', {
    get: () => state.currentTime,
    set: (v) => {
      state.currentTime = v;
    },
    configurable: true,
  });
  Object.defineProperty(video, 'duration', { get: () => state.duration, configurable: true });
  Object.defineProperty(video, 'readyState', { get: () => state.readyState, configurable: true });
  Object.defineProperty(video, 'networkState', { get: () => state.networkState, configurable: true });

  return {
    video,
    state,
    counts,
    listenerCount(type) {
      return counts[type] || 0;
    },
    fireEnded() {
      state.ended = true;
      state.paused = true;
      state.currentTime = state.duration;
      video.dispatchEvent(new doc.defaultView.Event('ended'));
    },
    firePause() {
      state.paused = true;
      video.dispatchEvent(new doc.defaultView.Event('pause'));
    },
  };
}

async function waitForState(Runner, target, maxMs) {
  const limit = maxMs || 4000;
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (Runner.state() === target) return true;
    await sleep(20);
  }
  return Runner.state() === target;
}

// ---------------- #3 视频播完但平台未确认 -> awaitingConfirm ----------------
test('回归#3：平台未确认时进入 awaitingConfirm，绝不自动当成功', async () => {
  const { exports, window } = env(jobHtml('unfinished'));
  const { Runner, Config } = exports;
  Config.load();
  Config.set('settleTimeoutMs', 250);
  Config.set('advanceTimeoutMs', 300);

  const job = window.document.querySelector('.ans-job');
  installVideo(job);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true, '应先进入 playing');

  // 触发结束，但不改完成态（平台没确认）
  job.querySelector('video').dispatchEvent(new window.Event('ended'));

  assert.equal(await waitForState(Runner, 'awaitingConfirm', 3000), true,
    '平台未确认时必须进入 awaitingConfirm，实际：' + Runner.state());

  await sleep(400);
  assert.notEqual(Runner.state(), 'playing', '不得回头重播');
  assert.notEqual(Runner.state(), 'completed', '未经确认不得宣布完成');
  assert.equal(Runner.snapshot().pendingCount, 0, '尚未跳过，pendingConfirm 应为 0');
  assert.equal(Runner.snapshot().confirmedCount, 0, '未确认不得计入成功');

  Runner.stop();
  window.close();
});

// ---------------- #3b 跳过并记录 -> pendingConfirm 且不再被选中 ----------------
test('回归#3b：跳过并记录后任务进入 pendingConfirm，且不会被再次自动选中', async () => {
  const { exports, window } = env(jobHtml('unfinished'));
  const { Runner, Config, CourseTree } = exports;
  Config.load();
  Config.set('settleTimeoutMs', 200);
  Config.set('advanceTimeoutMs', 200);

  const job = window.document.querySelector('.ans-job');
  installVideo(job);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true);
  job.querySelector('video').dispatchEvent(new window.Event('ended'));
  assert.equal(await waitForState(Runner, 'awaitingConfirm', 3000), true);

  Runner.skipAwaiting();
  await sleep(50);

  const keys = Runner.pendingKeys();
  assert.equal(keys.length, 1, '跳过后必须记录一个 pending key');
  assert.ok(keys[0].indexOf('video') !== -1, 'key 应包含任务类型');
  assert.equal(Runner.snapshot().pendingCount, 1);

  // 再给一次定位机会：被排除的任务不得被选中
  const jobs = CourseTree.enumerate();
  const pick = CourseTree.pickNextVideoTarget(jobs, null, { excludeKeys: new Set(keys) });
  assert.equal(pick.job, null, '已跳过的任务不得再次自动选中');

  Runner.stop();
  Config.clearPending();
  window.close();
});

// ---------------- #5 未知任务不得宣布整门课程完成 ----------------
test('回归#5：存在无法判定完成状态的任务时不得宣布完成', async () => {
  const { exports, window } = env(
    '<div class="ans-job">' +
      '<span class="ans-job-icon"></span>' +
      '<iframe src="/ananas/modules/video/index.html"></iframe>' +
      '</div>'
  );
  const { Runner, Config } = exports;
  Config.load();
  Config.set('advanceTimeoutMs', 200);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();

  // unknown 任务不会被当作目标 -> advance -> 无目录无按钮 -> 评估完成度
  const ok = await waitForState(Runner, 'needsReview', 4000);
  assert.equal(ok, true, '应进入 needsReview，实际：' + Runner.state());
  assert.notEqual(Runner.state(), 'completed', '证据不足时绝不能宣布完成');
  const reasons = (Runner.snapshot().completion || {}).reasons || [];
  assert.ok(
    reasons.some((r) => r.indexOf('task-unknown-state') !== -1),
    '原因里应包含 task-unknown-state，实际：' + reasons.join(';')
  );

  Runner.stop();
  window.close();
});

// ---------------- #6 进度停滞进入异常状态 ----------------
test('回归#6：播放中进度停滞且非加载时进入 blocked', async () => {
  const { exports, window } = env(jobHtml('unfinished'));
  const { Runner, Config } = exports;
  Config.load();
  Config.set('watchdogEnabled', true);
  Config.set('watchdogIntervalMs', 100);
  Config.set('stallTimeoutMs', 500);

  const job = window.document.querySelector('.ans-job');
  const ctrl = installVideo(job, { startTime: 5, duration: 100, readyState: 4, networkState: 1 });

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true);

  // 保持播放但 currentTime 不再变化
  const ok = await waitForState(Runner, 'blocked', 5000);
  assert.equal(ok, true, '停滞超过阈值应进入 blocked，实际：' + Runner.state());
  assert.ok(
    String(Runner.snapshot().lastError).indexOf('停滞') !== -1,
    '错误信息应说明停滞，实际：' + Runner.snapshot().lastError
  );

  Runner.stop();
  window.close();
});

// ---------------- #6b 加载中的停滞不判异常 ----------------
test('回归#6b：readyState 表明仍在加载时不误判停滞', async () => {
  const { exports, window } = env(jobHtml('unfinished'));
  const { Runner, Config } = exports;
  Config.load();
  Config.set('watchdogEnabled', true);
  Config.set('watchdogIntervalMs', 100);
  Config.set('stallTimeoutMs', 400);

  const job = window.document.querySelector('.ans-job');
  installVideo(job, { startTime: 5, duration: 100, readyState: 1, networkState: 2 });

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true);

  await sleep(1200);
  assert.equal(Runner.state(), 'playing', '仍在加载时不应判为停滞');

  Runner.stop();
  window.close();
});

// ---------------- #7 stop 后旧异步回调失效 ----------------
test('回归#7：stop() 之后旧回调不得再推进状态', async () => {
  const { exports, window } = env(jobHtml('unfinished'));
  const { Runner, Config } = exports;
  Config.load();

  const job = window.document.querySelector('.ans-job');
  const ctrl = installVideo(job);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true);

  Runner.stop();
  assert.equal(Runner.state(), 'stopped');

  // 停止后再触发 ended / pause，状态必须保持 stopped
  ctrl.fireEnded();
  ctrl.firePause();
  await sleep(300);

  assert.equal(Runner.state(), 'stopped', '停止后旧事件不得改变状态');
  window.close();
});

// ---------------- #8 暂停/继续不重复绑定监听器 ----------------
test('回归#8：暂停再继续不会叠加视频监听器', async () => {
  const { exports, window } = env(jobHtml('unfinished'));
  const { Runner, Config } = exports;
  Config.load();

  const job = window.document.querySelector('.ans-job');
  const ctrl = installVideo(job);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true);

  const before = ctrl.listenerCount('ended');
  assert.equal(before, 1, '初始应只绑定一次 ended');

  Runner.pause();
  await sleep(50);
  Runner.resume();
  assert.equal(await waitForState(Runner, 'playing'), true);

  const after = ctrl.listenerCount('ended');
  assert.equal(after, 1, '暂停/继续后 ended 监听器不得叠加，实际：' + after);

  Runner.stop();
  window.close();
});

// ---------------- #2 弹题尚未出现时不得误恢复 ----------------
test('回归#2：暂停后观察窗口内出现题目则进入 quizWait，不自动恢复', async () => {
  const { exports, window, document } = env(jobHtml('unfinished'));
  const { Runner, Config } = exports;
  Config.load();
  Config.set('pauseObserveMs', 400);

  const job = window.document.querySelector('.ans-job');
  const ctrl = installVideo(job);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  assert.equal(await waitForState(Runner, 'playing'), true);

  // 暂停，但题目 DOM 稍后才插入（模拟弹题延迟渲染）
  ctrl.firePause();
  await sleep(150);
  const quiz = document.createElement('div');
  quiz.className = 'ans-videoquiz';
  quiz.textContent = '题目';
  document.body.appendChild(quiz);

  const ok = await waitForState(Runner, 'quizWait', 3000);
  assert.equal(ok, true, '应进入 quizWait，实际：' + Runner.state());
  assert.equal(ctrl.state.paused, true, '不得在弹题时自动恢复播放');

  Runner.stop();
  window.close();
});
