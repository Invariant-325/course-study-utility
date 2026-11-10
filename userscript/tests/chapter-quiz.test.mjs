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
  '87-chapter-quiz.js',
  '88-chapter-quiz-runner.js',
];

// 真实结构（来自 2026-11-10 实机探测）：
//   <span class="num_option" data="D">A</span>
//   data = 平台内部答案标识（可能被随机化）
//   文本 = 用户看到的字母（按 DOM 顺序 A/B/C/D）
// 这里 letters 参数表示 data 值，显示字母固定按索引 A/B/C/D —— 与真实页面一致。
function singleQuestion(opts) {
  const o = opts || {};
  const encrypted = o.encrypted ? ' font-cxsecret fontLabel' : ' fontLabel';
  const letters = o.letters || ['D', 'A', 'C', 'B'];
  const texts = o.texts || ['选项一', '选项二', '选项三', '选项四'];
  const selectedIndex = o.selectedIndex;
  return (
    '<div class="TiMu newTiMu" data="' + (o.data || 0) + '">' +
    '<div class="Zy_TItle clearfix">' +
    '<i>' + (o.num || '1') + '</i>' +
    '<div class="clearfix' + encrypted + '"><span class="newZy_TItle">【单选题】</span>' + (o.stem || '题干一') + '</div>' +
    '</div>' +
    '<ul class="Zy_ulTop w-top fl">' +
    letters
      .map(function (letter, i) {
        const sel = selectedIndex === i ? ' before-after-select' : '';
        return (
          '<li role="radio" qid="q' + (o.num || '1') + letter + '" qtype="0" class="before-after' + sel + '" onclick="addChoice(this)">' +
          '<span class="num_option" data="' + letter + '">' + String.fromCharCode(65 + i) + '</span>' +
          '<a class="after">' + texts[i] + '</a>' +
          '</li>'
        );
      })
      .join('') +
    '</ul></div>'
  );
}

function multiQuestion(opts) {
  const o = opts || {};
  const letters = o.letters || ['B', 'A', 'D', 'C'];
  return (
    '<div class="TiMu newTiMu" data="' + (o.data || 1) + '">' +
    '<div class="Zy_TItle clearfix"><i>' + (o.num || '2') + '</i>' +
    '<div class="clearfix fontLabel"><span class="newZy_TItle">【多选题】</span>' + (o.stem || '题干二') + '</div></div>' +
    '<ul class="Zy_ulTop w-top fl">' +
    letters
      .map(function (letter, i) {
        return (
          '<li role="checkbox" qid="m' + (o.num || '2') + letter + '" qtype="1" class="before-after-checkbox" onclick="addMultipleChoice(this)">' +
          '<span class="num_option_dx" data="' + letter + '">' + String.fromCharCode(65 + i) + '</span>' +
          '<a class="after">多选' + letter + '</a>' +
          '</li>'
        );
      })
      .join('') +
    '</ul></div>'
  );
}

function env(html) {
  return loadEnv(FILES, { html: '<!doctype html><html><body>' + (html || '') + '</body></html>' });
}

test('解析：显示字母来自 span 文本，内部标识来自 data，两者分离', () => {
  const { exports, document } = env(singleQuestion() + multiQuestion());
  const quiz = exports.ChapterQuizAdapter.parse(document);

  assert.equal(quiz.ok, true);
  assert.equal(quiz.count, 2);

  const q1 = quiz.questions[0];
  assert.equal(q1.num, '1');
  assert.equal(q1.type, 'single');
  assert.equal(q1.options.length, 4);
  // 用户看到的字母按 DOM 顺序是 A,B,C,D
  assert.equal(q1.options.map((o) => o.letter).join(','), 'A,B,C,D');
  // 平台内部标识是打乱的 D,A,C,B（这正是必须区分两者的原因）
  assert.equal(q1.options.map((o) => o.internal).join(','), 'D,A,C,B');
  assert.equal(q1.options[0].text, '选项一');

  const q2 = quiz.questions[1];
  assert.equal(q2.type, 'multiple');
  assert.equal(q2.options.map((o) => o.letter).join(','), 'A,B,C,D');
  assert.equal(q2.options.map((o) => o.internal).join(','), 'B,A,D,C');
  assert.equal(q2.options[0].qid, 'm2B');
});

test('解析：题干剥离【单选题】前缀', () => {
  const { exports, document } = env(singleQuestion({ stem: '下列哪项正确？' }));
  const quiz = exports.ChapterQuizAdapter.parse(document);
  assert.ok(quiz.questions[0].stem.indexOf('【单选题】') === -1, '不应包含题型前缀');
  assert.ok(quiz.questions[0].stem.indexOf('下列哪项正确？') !== -1);
});

test('解析：识别字体加密并给出警告，但不猜测内容', () => {
  const { exports, document } = env(singleQuestion({ encrypted: true }));
  const quiz = exports.ChapterQuizAdapter.parse(document);
  assert.equal(quiz.ok, true);
  assert.equal(quiz.encryptedCount, 1);
  assert.equal(quiz.questions[0].encrypted, true);
  assert.ok(quiz.warnings.some((w) => w.indexOf('字体加密') !== -1));
});

test('填写：按显示字母匹配，而不是按 DOM 索引或内部标识', () => {
  const { exports, document } = env(singleQuestion({ letters: ['D', 'A', 'C', 'B'] }));
  const quiz = exports.ChapterQuizAdapter.parse(document);
  const q1 = quiz.questions[0];

  let clickedQid = null;
  for (const opt of q1.options) {
    opt.el.addEventListener('click', function () {
      clickedQid = opt.el.getAttribute('qid');
    });
  }

  // 用户说"选 C"：显示字母 C 在 DOM 索引 2，该选项 data=C、qid=q1C
  const result = exports.ChapterQuizAdapter.fill(q1, ['C']);
  assert.equal(result.ok, true, result.errors.join(';'));
  assert.equal(clickedQid, 'q1C', '必须点击显示字母为 C 的选项');

  // 再验证一个 data 与显示不同的：显示字母 B 在 DOM 索引 1，data=A、qid=q1A
  clickedQid = null;
  const result2 = exports.ChapterQuizAdapter.fill(q1, ['B'], { force: true });
  assert.equal(result2.ok, true, result2.errors.join(';'));
  assert.equal(clickedQid, 'q1A', '显示字母 B 对应 data=A，必须按显示字母定位到 q1A');
});

test('填写：目标字母不存在时拒绝', () => {
  const { exports, document } = env(singleQuestion());
  const quiz = exports.ChapterQuizAdapter.parse(document);
  const result = exports.ChapterQuizAdapter.fill(quiz.questions[0], ['Z']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.indexOf('选项不存在') !== -1));
});

test('填写：已有答案时默认不覆盖', () => {
  const { exports, document } = env(singleQuestion({ selectedIndex: 0 }));
  const quiz = exports.ChapterQuizAdapter.parse(document);
  const q1 = quiz.questions[0];
  assert.equal(q1.answered, true, '已有选中项应被识别');

  const result = exports.ChapterQuizAdapter.fill(q1, ['A']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.indexOf('已有填写内容') !== -1));
});

test('填写：加密题禁止自动填写', () => {
  const { exports, document } = env(singleQuestion({ encrypted: true }));
  const quiz = exports.ChapterQuizAdapter.parse(document);
  const result = exports.ChapterQuizAdapter.fill(quiz.questions[0], ['A']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.indexOf('加密') !== -1));
});

test('填写：缺少字母标识时拒绝（不按索引补）', () => {
  const { exports, document } = env(
    '<div class="TiMu newTiMu"><div class="Zy_TItle"><i>1</i>' +
      '<div class="fontLabel"><span class="newZy_TItle">【单选题】</span>没有字母的题</div></div>' +
      '<ul class="Zy_ulTop"><li role="radio"><span class="num_option">A</span><a class="after">甲</a></li>' +
      '<li role="radio"><span class="num_option">B</span><a class="after">乙</a></li></ul></div>'
  );
  const quiz = exports.ChapterQuizAdapter.parse(document);
  assert.equal(quiz.questions[0].missingLetters, true);
  const result = exports.ChapterQuizAdapter.fill(quiz.questions[0], ['A']);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.indexOf('字母') !== -1));
});

test('自检：填写后状态与预期一致时通过', () => {
  const { exports, document } = env(singleQuestion({ selectedIndex: 1 })); // DOM 索引 1 = 显示字母 B
  const quiz = exports.ChapterQuizAdapter.parse(document);
  const check = exports.ChapterQuizAdapter.verify(quiz.questions[0], ['B']);
  assert.equal(check.ok, true, JSON.stringify(check));
});

test('自检：状态与预期不一致时报告失败', () => {
  const { exports, document } = env(singleQuestion({ selectedIndex: 0 })); // DOM 索引 0 = 显示字母 A
  const quiz = exports.ChapterQuizAdapter.parse(document);
  const check = exports.ChapterQuizAdapter.verify(quiz.questions[0], ['C']);
  assert.equal(check.ok, false);
  assert.ok(Array.isArray(check.wrong) && check.wrong.length > 0);
});

test('稳定标识：同一题目重复解析得到相同 key', () => {
  const { exports, document } = env(singleQuestion());
  const a = exports.ChapterQuizAdapter.parse(document).questions[0].key;
  const b = exports.ChapterQuizAdapter.parse(document).questions[0].key;
  assert.equal(a, b);
});

test('稳定标识：题号相同但 qid 不同的两题 key 不同（防重复题干串答）', () => {
  const html =
    singleQuestion({ num: '1', stem: '同一道题干', letters: ['A', 'B'] }) +
    singleQuestion({ num: '1', stem: '同一道题干', letters: ['C', 'D'], data: 1 });
  const { exports, document } = env(html);
  const quiz = exports.ChapterQuizAdapter.parse(document);
  assert.equal(quiz.count, 2);
  assert.notEqual(quiz.questions[0].key, quiz.questions[1].key, '题干相同也必须区分');
});

test('检测：非测验页面不误判', () => {
  const { exports, document } = env('<div>普通页面</div>');
  // jsdom 的 URL 是 study 页，不是 doHomeWorkNew
  const detect = exports.ChapterQuizAdapter.detect(document);
  assert.equal(detect.isQuizPage, false);
});

test('按钮：识别 .btnSave 与 .btnSubmit', () => {
  const { exports, document } = env(
    singleQuestion() + '<a class="btnSave workBtnIndex">暂时保存</a><a class="btnSubmit workBtnIndex">提交</a>'
  );
  const btns = exports.ChapterQuizAdapter.buttons(document);
  assert.ok(btns.save, '应找到暂存按钮');
  assert.ok(btns.submit, '应找到提交按钮');
  assert.equal(String(btns.submit.className).indexOf('btnSubmit') !== -1, true);
});
