import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const FILES = ['10-log.js', '30-selectors.js', '35-urls.js', '40-dom.js', '65-pause.js'];

function setup(html) {
  const env = loadEnv(FILES, { html: '<!doctype html><html><body>' + (html || '') + '</body></html>' });
  return env;
}

// jsdom 的 visibilityState / hasFocus 只读，用 defineProperty 模拟（仅测试侧）
function forceVisibility(dom, state) {
  Object.defineProperty(dom.window.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(dom.window.document, 'hidden', {
    configurable: true,
    get: () => state === 'hidden',
  });
}
function forceFocus(dom, value) {
  dom.window.document.hasFocus = () => value;
}

function fakeVideo(overrides) {
  return Object.assign(
    {
      paused: true,
      ended: false,
      readyState: 4,
      networkState: 1,
      currentTime: 10,
      duration: 100,
    },
    overrides || {}
  );
}

test('分诊：ended 优先判定为正常结束，且不自动恢复', () => {
  const { exports } = setup();
  const verdict = exports.PauseClassifier.classify({
    video: fakeVideo({ ended: true }),
    now: Date.now(),
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'ended');
  assert.equal(verdict.autoResume, false);
});

// 回归用例 #1/#2 的单元部分：后台暂停不得自动恢复
test('分诊：页面隐藏判为 background 且不自动恢复', () => {
  const env = setup();
  forceVisibility(env.dom, 'hidden');
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo(),
    now: Date.now(),
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'background');
  assert.equal(verdict.autoResume, false, '后台暂停绝不能自动恢复');
});

test('分诊：窗口失焦（hasFocus=false 且刚 blur）判为 background', () => {
  const env = setup();
  forceFocus(env.dom, false);
  const now = Date.now();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo(),
    now: now,
    lastBlurAt: now - 5000,
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'background');
  assert.equal(verdict.autoResume, false);
});

test('分诊：失焦但已超过窗口期，不判 background', () => {
  const env = setup();
  forceFocus(env.dom, false);
  const now = Date.now();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo(),
    now: now,
    lastBlurAt: now - 120000,
    quizRootFound: false,
    options: { backgroundWindowMs: 60000 },
  });
  assert.notEqual(verdict.reason, 'background');
});

test('分诊：用户 3 秒内操作过判为 user，不自动恢复', () => {
  const env = setup();
  const now = Date.now();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo(),
    now: now,
    userIntentAt: now - 800,
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'user');
  assert.equal(verdict.autoResume, false);
});

test('分诊：readyState 不足判为 loading，不自动恢复', () => {
  const env = setup();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo({ readyState: 1 }),
    now: Date.now(),
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'loading');
  assert.equal(verdict.autoResume, false);
});

test('分诊：networkState=LOADING 判为 loading', () => {
  const env = setup();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo({ readyState: 4, networkState: 2 }),
    now: Date.now(),
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'loading');
});

test('分诊：最近有 stalled 事件判为 loading', () => {
  const env = setup();
  const now = Date.now();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo(),
    now: now,
    lastStalledAt: now - 1000,
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'loading');
  assert.equal(verdict.autoResume, false);
});

test('分诊：弹题容器存在时判为 quiz（优先于 user）', () => {
  const env = setup('<div class="ans-videoquiz">题目</div>');
  const now = Date.now();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo(),
    now: now,
    userIntentAt: now - 500, // 即使刚点过，也以题目为准
  });
  assert.equal(verdict.reason, 'quiz');
  assert.equal(verdict.autoResume, false);
});

test('分诊：只有真正无法解释时才允许恢复', () => {
  const env = setup();
  const verdict = env.exports.PauseClassifier.classify({
    video: fakeVideo({ readyState: 4, networkState: 1 }),
    now: Date.now(),
    userIntentAt: 0,
    lastBlurAt: 0,
    lastStalledAt: 0,
    quizRootFound: false,
  });
  assert.equal(verdict.reason, 'unexpected');
  assert.equal(verdict.autoResume, true);
});

test('分诊：只读检查不修改页面可见性', () => {
  const env = setup();
  const before = env.dom.window.document.visibilityState;
  env.exports.PauseClassifier.classify({ video: fakeVideo(), now: Date.now(), quizRootFound: false });
  assert.equal(env.dom.window.document.visibilityState, before, '不得篡改 visibilityState');
});
