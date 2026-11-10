import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const FILES = [
  '10-log.js',
  '20-config.js',
  '30-selectors.js',
  '35-urls.js',
  '40-dom.js',
  '66-quiz-model.js',
  '67-llm.js',
  '86-quiz-runner.js',
];

const SINGLE_HTML =
  '<div class="ans-videoquiz">' +
  '<div class="tkItem_title">下列哪项属于党的根本宗旨？</div>' +
  '<ul>' +
  '<li><label><input type="radio" name="q1" value="A" /> A. 全心全意为人民服务</label></li>' +
  '<li><label><input type="radio" name="q1" value="B" /> B. 追求利润最大化</label></li>' +
  '<li><label><input type="radio" name="q1" value="C" /> C. 扩大市场份额</label></li>' +
  '</ul>' +
  '<a id="videoquiz-submit">提交</a>' +
  '</div>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockGM(answerJson) {
  return function (options) {
    setTimeout(function () {
      options.onload({
        status: 200,
        responseText: JSON.stringify({ content: JSON.stringify(answerJson), usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      });
    }, 0);
  };
}

function env(html, options) {
  return loadEnv(FILES, Object.assign({ html: '<!doctype html><html><body>' + (html || '') + '</body></html>' }, options || {}));
}

function enableLlm(exports) {
  const cfg = {
    llmEnabled: true,
    llmMode: 'proxy',
    llmProxyUrl: 'http://127.0.0.1:8787',
    llmModel: 'deepseek-chat',
    llmMaxRetries: 0,
    quizAutoApply: true,
  };
  for (const key of Object.keys(cfg)) exports.Config.set(key, cfg[key]);
}

test('编排：AI 未开启时转人工，且不调用模型', async () => {
  let calls = 0;
  const { exports } = env(SINGLE_HTML, {
    gm: function () {
      calls++;
    },
  });
  exports.Config.set('llmEnabled', false);

  exports.QuizRunner.start();
  await sleep(80);
  const snap = exports.QuizRunner.snapshot();

  assert.equal(snap.phase, 'manual');
  assert.ok(String(snap.error).indexOf('AI 未开启') !== -1, '实际：' + snap.error);
  assert.equal(calls, 0, 'AI 关闭时不得发请求');
  exports.QuizRunner.stop();
});

test('编排：模型成功 → 给出建议并自动勾选正确选项', async () => {
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM({ answer: ['A'], reason: '根本宗旨', confidence: 0.95, uncertain: false }),
  });
  enableLlm(exports);

  exports.QuizRunner.start();
  await sleep(200);
  const snap = exports.QuizRunner.snapshot();

  assert.equal(snap.phase, 'suggested', '实际 phase=' + snap.phase + ' error=' + snap.error);
  assert.equal(snap.suggestion.letters.join(','), 'A');
  assert.equal(snap.applied, true, '应自动勾选建议项');

  assert.equal(document.querySelector('input[value="A"]').checked, true, 'A 必须被勾选');
  assert.equal(document.querySelector('input[value="B"]').checked, false, 'B 不得被勾选');
  assert.equal(document.querySelector('input[value="C"]').checked, false, 'C 不得被勾选');

  exports.QuizRunner.stop();
});

test('编排：自动勾选关闭时只给建议不动 DOM', async () => {
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM({ answer: ['B'], confidence: 0.8 }),
  });
  enableLlm(exports);
  exports.Config.set('quizAutoApply', false);

  exports.QuizRunner.start();
  await sleep(200);
  const snap = exports.QuizRunner.snapshot();

  assert.equal(snap.phase, 'suggested');
  assert.equal(snap.applied, false);
  assert.equal(document.querySelector('input[value="B"]').checked, false, '未授权时不得改动勾选');

  exports.QuizRunner.stop();
});

test('编排：submit 点击提交按钮并标记已提交', async () => {
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM({ answer: ['A'], confidence: 0.9 }),
  });
  enableLlm(exports);

  let clicks = 0;
  document.getElementById('videoquiz-submit').addEventListener('click', function () {
    clicks++;
  });

  exports.QuizRunner.start();
  await sleep(200);
  const ok = exports.QuizRunner.submit();

  assert.equal(ok, true);
  assert.equal(clicks, 1, '提交按钮应被点击一次');
  assert.equal(exports.QuizRunner.snapshot().submitted, true);

  // 重复提交应被拒绝
  assert.equal(exports.QuizRunner.submit(), false);
  assert.equal(clicks, 1, '不得重复提交');

  exports.QuizRunner.stop();
});

test('编排：同一道题不会重复请求模型', async () => {
  let calls = 0;
  const { exports } = env(SINGLE_HTML, {
    gm: function (options) {
      calls++;
      setTimeout(function () {
        options.onload({
          status: 200,
          responseText: JSON.stringify({ content: JSON.stringify({ answer: ['A'], confidence: 0.9 }) }),
        });
      }, 0);
    },
  });
  enableLlm(exports);

  exports.QuizRunner.start();
  await sleep(200);
  assert.equal(calls, 1);

  // 再次触发检测（模拟 DOM 抖动）：题目未变，不应再请求
  exports.QuizRunner.resolve('noop');
  exports.QuizRunner.start();
  await sleep(200);

  assert.equal(calls, 1, '同一题不得重复请求');
  exports.QuizRunner.stop();
});

test('编排：模型返回非法选项时转人工，且不自动勾选', async () => {
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM({ answer: ['Z'], confidence: 0.9 }),
  });
  enableLlm(exports);

  exports.QuizRunner.start();
  await sleep(200);
  const snap = exports.QuizRunner.snapshot();

  assert.equal(snap.phase, 'manual', '越界答案必须转人工');
  assert.ok(String(snap.error).length > 0);
  assert.equal(document.querySelector('input[value="A"]').checked, false);
  assert.equal(document.querySelector('input[value="B"]').checked, false);

  exports.QuizRunner.stop();
});

test('编排：resolve 会触发 onResolved 回调并停止监听', () => {
  const { exports } = env(SINGLE_HTML);
  exports.Config.set('llmEnabled', false);

  let resolvedReason = '';
  exports.QuizRunner.setHooks({
    onResolved: function (reason) {
      resolvedReason = reason;
    },
  });

  exports.QuizRunner.start();
  exports.QuizRunner.resolve('quiz-gone');

  assert.equal(resolvedReason, 'quiz-gone');
  assert.equal(exports.QuizRunner.isRunning(), false);
});

test('编排：无法识别的题目进入 manual 而不是猜测', async () => {
  const { exports } = env('<div class="ans-videoquiz"><div>没有选项的容器</div></div>');
  enableLlm(exports);

  exports.QuizRunner.start();
  await sleep(80);
  const snap = exports.QuizRunner.snapshot();

  assert.equal(snap.phase, 'manual');
  assert.ok(String(snap.error).indexOf('无法可靠识别') !== -1, '实际：' + snap.error);

  exports.QuizRunner.stop();
});
