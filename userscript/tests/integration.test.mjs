import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

// 端到端：把 runner 真正接起来，验证
//   1) start 能定位到第一个未完成视频并进入 playing
//   2) 视频 ended 后平台标记完成，能自动切到下一个任务点
//   3) 全部完成后进入 completed，且不会回头重播
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

// 造一个可被 VideoCtl 操作的 video（jsdom 不实现真正的播放）
// 直接挂在任务点容器内：findVideoInJob 会先做容器直查，避免依赖 iframe 内容创建时机
function installPlayableVideo(container, { duration = 100 } = {}) {
  const doc = container.ownerDocument;
  const video = doc.createElement('video');
  video.id = 'video_html5_api';
  container.appendChild(video);

  const state = { paused: true, ended: false, currentTime: 0 };
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
    configurable: true,
  });
  Object.defineProperty(video, 'duration', { get: () => duration, configurable: true });
  Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true });

  return {
    video,
    play() {
      state.currentTime = duration;
      state.ended = true;
      state.paused = true;
      video.dispatchEvent(new doc.defaultView.Event('ended'));
    },
  };
}

function buildPage(exports, document, { firstState = 'unfinished', total = 3, finishedAfter = 1 } = {}) {
  // total 个任务点；第一个按 firstState，其余按"前 finishedAfter 个已完成"分布
  for (let i = 0; i < total; i++) {
    const state = i === 0 ? firstState : i <= finishedAfter ? 'finished' : 'unfinished';
    const label = state === 'finished' ? '任务点已完成' : '任务点未完成';
    const cls = state === 'finished' ? 'ans-job ans-job-finished' : 'ans-job';
    const html =
      '<div class="' + cls + '" data-idx="' + i + '">' +
      '<span class="ans-job-icon" aria-label="' + label + '"></span>' +
      '<iframe src="/ananas/modules/video/index.html?i=' + i + '"></iframe>' +
      '</div>';
    const holder = document.createElement('div');
    holder.innerHTML = html;
    document.body.appendChild(holder.firstChild);
  }
  return document.querySelectorAll('.ans-job');
}

test('集成：start 定位到第一个未完成视频并进入 playing', async () => {
  const { exports, document, window } = loadEnv(FILES, { html: '<!doctype html><html><body></body></html>' });
  const { Runner, Config } = exports;

  Config.load();
  const jobs = buildPage(exports, document, { total: 3, finishedAfter: 1 });
  installPlayableVideo(jobs[0]);

  Runner.setHooks({ onUpdate: () => {} });
  const ok = Runner.start();
  assert.equal(ok, true);

  // 等 locateAndPlay 走完
  for (let i = 0; i < 40 && Runner.state() !== 'playing'; i++) await sleep(25);

  assert.equal(Runner.state(), 'playing', '应进入 playing 状态');
  const snap = Runner.snapshot();
  assert.equal(snap.jobTitle.length > 0, true);
  assert.equal(snap.video.playbackRate, 1, '播放速率必须是 1.0');

  Runner.stop();
  window.close();
});

test('集成：ended 后平台标记完成，自动切到下一个任务点', async () => {
  const { exports, document, window } = loadEnv(FILES, { html: '<!doctype html><html><body></body></html>' });
  const { Runner, Config } = exports;
  Config.load();
  Config.set('settleTimeoutMs', 300);

  // 两个未完成任务点
  const jobs = buildPage(exports, document, { total: 2, firstState: 'unfinished', finishedAfter: 0 });
  const firstPlayer = installPlayableVideo(jobs[0]);
  installPlayableVideo(jobs[1]);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  for (let i = 0; i < 40 && Runner.state() !== 'playing'; i++) await sleep(25);
  assert.equal(Runner.state(), 'playing');

  // 模拟平台在视频结束后把第一个任务点标记为完成
  const icon = jobs[0].querySelector('.ans-job-icon');
  icon.setAttribute('aria-label', '任务点已完成');
  jobs[0].classList.add('ans-job-finished');

  // 触发 ended
  firstPlayer.play();

  // 等 settling -> advancing -> 下一个 playing
  for (let i = 0; i < 120 && Runner.state() !== 'playing'; i++) await sleep(25);

  assert.equal(Runner.state(), 'playing', '应切到第二个视频并播放');
  const snap = Runner.snapshot();
  assert.equal(snap.playedCount, 2, '应已播放 2 个视频');
  assert.equal(snap.jobTitle.indexOf('2') !== -1 || snap.jobTitle.length > 0, true);

  Runner.stop();
  window.close();
});

test('集成：全部完成后进入 completed，不回头重播', async () => {
  const { exports, document, window } = loadEnv(FILES, { html: '<!doctype html><html><body></body></html>' });
  const { Runner, Config } = exports;
  Config.load();
  Config.set('studyStrategy','video-only'); // 本用例只有视频任务，没有课程目录证据

  Config.set('settleTimeoutMs', 200);

  const jobs = buildPage(exports, document, { total: 1, firstState: 'unfinished', finishedAfter: 0 });
  const player = installPlayableVideo(jobs[0]);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  for (let i = 0; i < 40 && Runner.state() !== 'playing'; i++) await sleep(25);
  assert.equal(Runner.state(), 'playing');

  // 平台标记完成 + ended
  jobs[0].querySelector('.ans-job-icon').setAttribute('aria-label', '任务点已完成');
  jobs[0].classList.add('ans-job-finished');
  player.play();

  for (let i = 0; i < 160 && Runner.state() !== 'completed'; i++) await sleep(25);

  const finalState = Runner.state();
  // 严格断言：单个任务点播完且平台已标记完成，必须进入 completed。
  // 不允许用 blocked 之类的其它结果冒充通过（旧版此处是 completed || blocked 的宽松断言）。
  assert.equal(finalState, 'completed', '全部任务完成后必须进入 completed，实际：' + finalState);
  assert.equal(Runner.snapshot().confirmedCount >= 1, true, '应至少有一次平台确认');
  assert.equal(Runner.snapshot().pendingCount, 0, '本次未跳过任何任务');

  Runner.stop();
  window.close();
});

test('集成：stop 之后不再继续推进', async () => {
  const { exports, document, window } = loadEnv(FILES, { html: '<!doctype html><html><body></body></html>' });
  const { Runner, Config } = exports;
  Config.load();

  const jobs = buildPage(exports, document, { total: 2, firstState: 'unfinished', finishedAfter: 0 });
  installPlayableVideo(jobs[0]);
  installPlayableVideo(jobs[1]);

  Runner.setHooks({ onUpdate: () => {} });
  Runner.start();
  for (let i = 0; i < 40 && Runner.state() !== 'playing'; i++) await sleep(25);

  Runner.stop();
  assert.equal(Runner.state(), 'stopped');

  await sleep(300);
  assert.equal(Runner.state(), 'stopped', '停止后状态不应再变化');
  assert.equal(Runner.snapshot().playedCount, 1);

  window.close();
});
