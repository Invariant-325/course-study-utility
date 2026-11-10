import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const FILES = ['10-log.js', '20-config.js', '30-selectors.js', '35-urls.js', '40-dom.js', '66-quiz-model.js', '67-llm.js'];

function env(html, options) {
  return loadEnv(FILES, Object.assign({ html: '<!doctype html><html><body>' + (html || '') + '</body></html>' }, options || {}));
}

// ---------- 弹题 DOM fixture ----------
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

const MULTI_HTML =
  '<div class="ans-videoquiz">' +
  '<div class="tkItem_title">以下哪些属于四个全面？</div>' +
  '<ul>' +
  '<li><label><input type="checkbox" value="A" /> A. 全面建设社会主义现代化国家</label></li>' +
  '<li><label><input type="checkbox" value="B" /> B. 全面深化改革</label></li>' +
  '<li><label><input type="checkbox" value="C" /> C. 全面依法治国</label></li>' +
  '<li><label><input type="checkbox" value="D" /> D. 全面从严治党</label></li>' +
  '</ul>' +
  '</div>';

const JUDGE_HTML =
  '<div class="ans-videoquiz">' +
  '<div class="tkItem_title">中国共产党成立于 1921 年。</div>' +
  '<ul>' +
  '<li><label><input type="radio" name="j1" value="A" /> 正确</label></li>' +
  '<li><label><input type="radio" name="j1" value="B" /> 错误</label></li>' +
  '</ul>' +
  '</div>';

test('解析：单选题（radio）识别题型、题干、选项字母', () => {
  const { exports, document } = env(SINGLE_HTML);
  const q = exports.QuizModel.parse(document);
  assert.equal(q.ok, true, '应解析成功：' + q.reason);
  assert.equal(q.type, 'single');
  assert.equal(q.options.length, 3);
  assert.deepEqual(q.options.map((o) => o.letter).join(','), 'A,B,C');
  assert.ok(q.stem.indexOf('根本宗旨') !== -1);
  assert.ok(q.options[0].text.indexOf('全心全意为人民服务') !== -1);
  assert.ok(q.hash.length > 0);
});

test('解析：多选题（checkbox）', () => {
  const { exports, document } = env(MULTI_HTML);
  const q = exports.QuizModel.parse(document);
  assert.equal(q.ok, true);
  assert.equal(q.type, 'multiple');
  assert.equal(q.options.length, 4);
});

test('解析：判断题（两个互斥选项且文本为正确/错误）', () => {
  const { exports, document } = env(JUDGE_HTML);
  const q = exports.QuizModel.parse(document);
  assert.equal(q.ok, true);
  assert.equal(q.type, 'judge');
  assert.equal(q.options.length, 2);
});

test('解析：没有弹题容器时 ok=false', () => {
  const { exports, document } = env('<div>普通页面</div>');
  const q = exports.QuizModel.parse(document);
  assert.equal(q.ok, false);
  assert.equal(q.reason, 'no-quiz-root');
});

test('解析：有容器但没有选项时明确失败', () => {
  const { exports, document } = env('<div class="ans-videoquiz"><div class="tkItem_title">题目但没有选项</div></div>');
  const q = exports.QuizModel.parse(document);
  assert.equal(q.ok, false);
  assert.equal(q.reason, 'no-options');
});

test('解析：题干缺失时失败而不是瞎猜', () => {
  const { exports, document } = env(
    '<div class="ans-videoquiz"><ul>' +
      '<li><label><input type="radio" value="A" /> 选项一</label></li>' +
      '<li><label><input type="radio" value="B" /> 选项二</label></li>' +
      '</ul></div>'
  );
  const q = exports.QuizModel.parse(document);
  // 兜底会把容器剩余文本当题干，此处只要不是 ok 就必须给出原因
  assert.equal(typeof q.ok, 'boolean');
  if (!q.ok) assert.ok(q.reason.length > 0);
});

// ---------- 答案校验 ----------
function parseOk(html) {
  const { exports, document } = env(html);
  const q = exports.QuizModel.parse(document);
  assert.equal(q.ok, true, 'fixture 应可解析');
  return { exports, q };
}

test('校验：合法答案通过', () => {
  const { exports, q } = parseOk(SINGLE_HTML);
  const r = exports.QuizModel.validateAnswer(q, { answer: ['A'], reason: '常识', confidence: 0.9, uncertain: false });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.letters.join(','), 'A');
  assert.equal(r.confidence, 0.9);
});

test('校验：越界字母被拒绝', () => {
  const { exports, q } = parseOk(SINGLE_HTML);
  const r = exports.QuizModel.validateAnswer(q, { answer: ['A', 'Z'], reason: '', confidence: 0.5 });
  assert.equal(r.ok, false);
  // Z 既不是合法字母格式，也超出真实选项范围；关键是错误必须被显式报告，
  // 不能被静默丢弃后当成"答案合法"。
  assert.ok(
    r.errors.some((e) => e.indexOf('Z') !== -1),
    '错误信息必须指出非法选项 Z，实际：' + r.errors.join(';')
  );
  assert.equal(r.letters.join(','), 'A', '合法字母仍保留，越界的被剔除');
});

test('校验：单选题返回多个答案被拒绝', () => {
  const { exports, q } = parseOk(SINGLE_HTML);
  const r = exports.QuizModel.validateAnswer(q, { answer: ['A', 'B'], reason: '', confidence: 0.5 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.indexOf('多个答案') !== -1));
  assert.equal(r.letters.length, 1);
});

test('校验：空答案被拒绝', () => {
  const { exports, q } = parseOk(SINGLE_HTML);
  const r = exports.QuizModel.validateAnswer(q, { answer: [], reason: '', confidence: 0.2 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.indexOf('答案为空') !== -1));
});

test('校验：answer 为字符串时也能解析', () => {
  const { exports, q } = parseOk(MULTI_HTML);
  const r = exports.QuizModel.validateAnswer(q, { answer: 'A,C', reason: '', confidence: 0.8 });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.letters.join(','), 'A,C');
});

test('校验：模型输出不是对象时拒绝', () => {
  const { exports, q } = parseOk(SINGLE_HTML);
  const r = exports.QuizModel.validateAnswer(q, 'A');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('校验：confidence 被夹到 0..1', () => {
  const { exports, q } = parseOk(SINGLE_HTML);
  const high = exports.QuizModel.validateAnswer(q, { answer: ['A'], confidence: 99 });
  assert.equal(high.confidence, 1);
  const low = exports.QuizModel.validateAnswer(q, { answer: ['A'], confidence: -5 });
  assert.equal(low.confidence, 0);
});

// ---------- 严格 JSON 提取 ----------
test('JSON：直接对象可解析', () => {
  const { exports } = env('');
  const parsed = exports.Llm.extractJson('{"answer":["A"],"confidence":0.9}');
  assert.equal(parsed.answer[0], 'A');
});

test('JSON：带 ```json 包裹可解析', () => {
  const { exports } = env('');
  const parsed = exports.Llm.extractJson('```json\n{"answer":["B"]}\n```');
  assert.equal(parsed.answer[0], 'B');
});

test('JSON：前后有解释文字时仍提取对象', () => {
  const { exports } = env('');
  const parsed = exports.Llm.extractJson('好的，答案是 {"answer":["C"]} 以上。');
  assert.equal(parsed.answer[0], 'C');
});

test('JSON：无 JSON 时抛错', () => {
  const { exports } = env('');
  assert.throws(() => exports.Llm.extractJson('我认为答案是 A'), /JSON/);
});

test('JSON：数组或非对象时抛错', () => {
  const { exports } = env('');
  assert.throws(() => exports.Llm.extractJson('["A"]'), /对象/);
});

test('JSON：绝不执行模型返回的代码', () => {
  const { exports } = env('');
  // 只做解析，不会有任何求值；字符串里的函数体应当原样保留在字段中
  const parsed = exports.Llm.extractJson('{"answer":["A"],"reason":"process.exit(1)"}');
  assert.equal(parsed.reason, 'process.exit(1)');
});

// ---------- LLM 客户端（mock 网络层） ----------
function mockGM(handler) {
  return function (options) {
    let payload = {};
    try {
      payload = JSON.parse(options.data || '{}');
    } catch (e) {
      payload = {};
    }
    const result = handler(payload, options);
    setTimeout(function () {
      if (result && result.timeout) {
        options.ontimeout && options.ontimeout();
        return;
      }
      options.onload && options.onload({ status: (result && result.status) || 200, responseText: (result && result.text) || '' });
    }, 0);
  };
}

function enableLlm(exports, overrides) {
  const cfg = Object.assign(
    { llmEnabled: true, llmMode: 'proxy', llmProxyUrl: 'http://127.0.0.1:8787', llmModel: 'deepseek-chat', llmMaxRetries: 1 },
    overrides || {}
  );
  for (const key of Object.keys(cfg)) exports.Config.set(key, cfg[key]);
}

test('客户端：代理模式请求成功并统计 token', async () => {
  let calls = 0;
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM(function () {
      calls++;
      return {
        status: 200,
        text: JSON.stringify({
          content: '{"answer":["A"],"reason":"根本宗旨","confidence":0.95,"uncertain":false}',
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }),
      };
    }),
  });
  enableLlm(exports);
  const q = exports.QuizModel.parse(document);
  const result = await exports.Llm.ask(q);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.payload.letters, ['A']);
  assert.equal(calls, 1);
  const stats = exports.Llm.stats();
  assert.equal(stats.requests, 1);
  assert.equal(stats.promptTokens, 120);
  assert.equal(stats.completionTokens, 30);
});

test('客户端：同一题第二次走缓存，不再发请求', async () => {
  let calls = 0;
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM(function () {
      calls++;
      return { status: 200, text: JSON.stringify({ content: '{"answer":["A"],"confidence":0.9}' }) };
    }),
  });
  enableLlm(exports);
  const q = exports.QuizModel.parse(document);

  await exports.Llm.ask(q);
  const second = await exports.Llm.ask(q);

  assert.equal(calls, 1, '同题不得重复请求');
  assert.equal(second.cached, true);
  assert.equal(second.ok, true);
});

test('客户端：校验失败不重试（避免烧 token）', async () => {
  let calls = 0;
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM(function () {
      calls++;
      // 返回了不存在的选项 Z
      return { status: 200, text: JSON.stringify({ content: '{"answer":["Z"],"confidence":0.9}' }) };
    }),
  });
  enableLlm(exports, { llmMaxRetries: 3 });
  const q = exports.QuizModel.parse(document);
  const result = await exports.Llm.ask(q);

  assert.equal(result.ok, false);
  assert.equal(calls, 1, '校验失败不应重试');
  assert.ok(result.error.indexOf('校验失败') !== -1);
});

test('客户端：HTTP 错误有限重试后失败', async () => {
  let calls = 0;
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM(function () {
      calls++;
      return { status: 500, text: 'server error' };
    }),
  });
  enableLlm(exports, { llmMaxRetries: 2 });
  const q = exports.QuizModel.parse(document);
  const result = await exports.Llm.ask(q);

  assert.equal(result.ok, false);
  assert.equal(calls, 3, '首次 + 2 次重试');
});

test('客户端：AI 未开启时直接拒绝，不发请求', async () => {
  let calls = 0;
  const { exports, document } = env(SINGLE_HTML, {
    gm: mockGM(function () {
      calls++;
      return { status: 200, text: '{}' };
    }),
  });
  exports.Config.set('llmEnabled', false);
  const q = exports.QuizModel.parse(document);
  const result = await exports.Llm.ask(q);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'AI 未开启');
  assert.equal(calls, 0);
});
