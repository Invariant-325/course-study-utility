// ---------------------------------------------------------------------------
// app.js —— 控制面板逻辑
// 通过 window.__cxApp（preload 暴露）与主进程通信
// ---------------------------------------------------------------------------
const App = window.__cxApp;
const $ = (id) => document.getElementById(id);

function log(text, kind) {
  const box = $('log');
  if (!box) return;
  const line = document.createElement('div');
  if (kind) line.className = kind;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = '[' + t + '] ' + text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.childNodes.length > 300) box.removeChild(box.firstChild);
}

function showMsg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (text ? ' show ' : ' ') + (kind || 'info');
}

function fmtErr(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.error || e.message || JSON.stringify(e);
}

// ---------------------------------------------------------------- 顶部导航
$('btnBack').onclick = () => App.back();
$('btnReload').onclick = () => App.reload();
$('btnHome').onclick = () => App.goto('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu');
$('btnStudy').onclick = () => App.goto('https://mooc1.chaoxing.com/mycourse/studentstudy');

// ---------------------------------------------------------------- 状态轮询
let lastStateText = '';

async function pollPage() {
  try {
    const info = await App.pageInfo();
    $('urlBox').textContent = info.url || 'about:blank';
  } catch (e) {
    /* ignore */
  }
}

async function pollRunner() {
  try {
    const r = await App.evalMain(`(function(){
      var app = window.__cxNaturalWatchApp;
      if (!app || !app.runner) return { ok: false, reason: 'not-mounted' };
      var s = null;
      try { s = app.runner.snapshot(); } catch (e) { return { ok: false, reason: 'snapshot-error' }; }
      return { ok: true, snap: s };
    })()`);

    if (!r || !r.ok) {
      $('vState').textContent = '未挂载';
      $('vJob').textContent = '—';
      $('vProg').textContent = '—';
      $('vCount').textContent = '—';
      return;
    }
    const d = r.result;
    if (!d || !d.ok) {
      $('vState').textContent = d && d.reason === 'not-mounted' ? '未挂载（先进入学习页）' : '读取失败';
      return;
    }
    const s = d.snap || {};
    const stateText = s.stateLabel || s.state || '—';
    $('vState').textContent = stateText;
    $('vJob').textContent = (s.jobTitle || '—') + (s.jobType ? '（' + s.jobType + '）' : '');
    const v = s.video || {};
    $('vProg').textContent =
      v.duration > 0 ? (v.currentTime || 0).toFixed(0) + 's / ' + v.duration.toFixed(0) + 's' : '—';
    $('vCount').textContent =
      (s.playedCount || 0) + ' 播放 / ' + (s.confirmedCount || 0) + ' 确认 / ' + (s.pendingCount || 0) + ' 待完成';

    if (stateText !== lastStateText) {
      log('视频状态：' + stateText, s.state === 'paused' ? 'warn' : s.state === 'completed' ? 'ok' : '');
      lastStateText = stateText;
    }
  } catch (e) {
    /* ignore */
  }
}

async function pollQuiz() {
  try {
    const r = await App.evalQuiz(`(function(){
      if (!window.__cxChapterQuiz) return { ok: false, reason: 'no-api' };
      var quiz = window.__cxChapterQuiz.adapter.parse(document);
      return {
        ok: true,
        count: quiz.count,
        encrypted: quiz.encryptedCount,
        warnings: quiz.warnings,
        items: quiz.questions.map(function(q){
          return { num: q.num, type: q.type, typeLabel: q.typeLabel, stem: (q.stem||'').slice(0,60), answered: q.answered,
                   letters: q.options.map(function(o){ return o.letter; }) };
        })
      };
    })()`);

    if (!r || !r.ok) {
      $('qPage').textContent = '不在测验页';
      $('qCount').textContent = '—';
      return;
    }
    const d = r.result;
    if (!d || !d.ok) {
      $('qPage').textContent = d && d.reason === 'no-api' ? '脚本未注入' : '不在测验页';
      $('qCount').textContent = '—';
      return;
    }
    $('qPage').textContent = '已识别';
    $('qCount').textContent = d.count + ' 题（加密 ' + d.encrypted + '）';
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 视频控制
function bindRunnerButtons() {
  const call = async (name, arg) => {
    try {
      const r = await App.evalMain(
        '(function(){ var a = window.__cxNaturalWatchApp; if (!a || !a.runner) return { ok:false, reason:"not-mounted" }; ' +
          'try { var v = a.runner.' + name + '(' + (arg || '') + '); return { ok:true, value: v===undefined?"ok":String(v) }; }' +
          'catch(e){ return { ok:false, reason:String(e && e.message) }; } })()'
      );
      if (!r || !r.ok) return showMsg('vMsg', '未挂载：请先进入课程学习页', 'err');
      const d = r.result || {};
      if (!d.ok) return showMsg('vMsg', fmtErr(d), 'err');
      showMsg('vMsg', name + ' → ' + (d.value || 'ok'), 'ok');
      log('操作 ' + name + '：' + (d.value || 'ok'), 'ok');
      pollRunner();
    } catch (e) {
      showMsg('vMsg', '调用失败：' + fmtErr(e), 'err');
    }
  };

  $('vStart').onclick = () => call('start');
  $('vPause').onclick = () => call('pause');
  $('vResume').onclick = () => call('resume');
  $('vStop').onclick = () => call('stop');
}

// ---------------------------------------------------------------- AI 答题
let lastAnswers = [];

const SCAN_CODE = `(function(){
  if (!window.__cxChapterQuiz) return { ok:false, reason:'no-api' };
  var quiz = window.__cxChapterQuiz.adapter.parse(document);
  return { ok:true, count:quiz.count, encrypted:quiz.encryptedCount,
    items: quiz.questions.map(function(q){ return { num:q.num, type:q.type, stem:(q.stem||'').slice(0,50) }; }) };
})()`;

const ANALYZE_CODE = `(async function(){
  var api = window.__cxChapterQuiz;
  if (!api) return { ok:false, error:'no-api' };
  var quiz = api.adapter.parse(document);
  var out = [];
  for (var i = 0; i < quiz.questions.length; i++) {
    var q = quiz.questions[i];
    var id = 'q_' + (i + 1);
    if (q.encrypted) {
      var img = api.image.render(q);
      if (!img.ok) { out.push({ id:id, num:q.num, ok:false, error:'图像生成失败:' + img.reason }); continue; }
      if (img.unsupported && img.unsupported.length) { out.push({ id:id, num:q.num, ok:false, error:'含图片/公式，需人工' }); continue; }
      var letters = q.options.map(function(o){ return o.letter; });
      var r = await window.__cxHost.askVision({ questionId:id, imageBase64:img.dataUrl, allowedLetters:letters });
      out.push({ id:id, num:q.num, ok:!!r.ok, answers:r.answers||[], status:r.status, error:r.error||'' });
    } else {
      out.push({ id:id, num:q.num, ok:false, error:'题目未加密，走文本模型（暂未接入面板）' });
    }
  }
  return { ok:true, results: out };
})()`;

const FILL_CODE = (answersJson) => `(function(){
  var api = window.__cxChapterQuiz;
  if (!api) return { ok:false, error:'no-api' };
  var quiz = api.adapter.parse(document);
  var map = ${answersJson};
  var out = [];
  for (var i = 0; i < quiz.questions.length; i++) {
    var q = quiz.questions[i];
    var id = 'q_' + (i + 1);
    var letters = map[id];
    if (!letters || !letters.length) continue;
    var r = api.adapter.fill(q, letters, { force:false, source:'vision' });
    var v = api.adapter.verify(q, letters);
    out.push({ id:id, num:q.num, filled:r.ok, applied:r.applied||0, verified:v.ok, detail:v.detail||'', error:(r.errors||[]).join(',') });
  }
  return { ok:true, results: out };
})()`;

function renderAnswers(list) {
  const box = $('qList');
  box.textContent = '';
  for (const item of list) {
    const div = document.createElement('div');
    div.className = 'qitem';
    const head = document.createElement('div');
    head.className = 'qh';
    head.textContent = '#' + item.num + ' ' + (item.id || '');
    div.appendChild(head);

    if (item.ok) {
      const a = document.createElement('div');
      a.className = 'qa';
      a.textContent = (item.answers || []).join(', ') || '—';
      div.appendChild(a);
    } else {
      const e = document.createElement('div');
      e.className = 'qe';
      e.textContent = item.error || '未识别';
      div.appendChild(e);
    }
    if (item.stem) {
      const s = document.createElement('div');
      s.className = 'stem';
      s.textContent = item.stem;
      div.appendChild(s);
    }
    box.appendChild(div);
  }
}

async function doScan() {
  showMsg('qMsg', '正在扫描…', 'info');
  const r = await App.evalQuiz(SCAN_CODE);
  if (!r || !r.ok) return showMsg('qMsg', '扫描失败：' + fmtErr(r), 'err');
  const d = r.result;
  if (!d || !d.ok) return showMsg('qMsg', '不在测验页或脚本未注入', 'err');
  showMsg('qMsg', '扫描到 ' + d.count + ' 题，加密 ' + d.encrypted + ' 题', 'ok');
  log('测验扫描：' + d.count + ' 题', 'ok');
  pollQuiz();
}

async function doAnalyze() {
  showMsg('qMsg', '正在识别（每题约 4-5 秒）…', 'info');
  log('开始视觉识别…', '');
  const started = Date.now();
  const r = await App.evalQuiz(ANALYZE_CODE);
  if (!r || !r.ok) return showMsg('qMsg', '识别失败：' + fmtErr(r), 'err');
  const d = r.result;
  if (!d || !d.ok) return showMsg('qMsg', '识别失败：' + fmtErr(d), 'err');

  lastAnswers = d.results || [];
  renderAnswers(lastAnswers);
  const okCount = lastAnswers.filter((x) => x.ok).length;
  const secs = Math.round((Date.now() - started) / 1000);
  showMsg('qMsg', '识别完成：' + okCount + '/' + lastAnswers.length + ' 题成功，用时 ' + secs + ' 秒', okCount ? 'ok' : 'err');
  log('视觉识别完成 ' + okCount + '/' + lastAnswers.length + '，' + secs + 's', okCount ? 'ok' : 'err');
}

async function doFill() {
  if (!lastAnswers.length) return showMsg('qMsg', '请先识别', 'err');
  const map = {};
  for (const a of lastAnswers) {
    if (a.ok && a.answers && a.answers.length) map[a.id] = a.answers;
  }
  if (!Object.keys(map).length) return showMsg('qMsg', '没有可用答案', 'err');

  const r = await App.evalQuiz(FILL_CODE(JSON.stringify(map)));
  if (!r || !r.ok) return showMsg('qMsg', '填写失败：' + fmtErr(r), 'err');
  const d = r.result;
  if (!d || !d.ok) return showMsg('qMsg', '填写失败：' + fmtErr(d), 'err');

  const results = d.results || [];
  const allOk = results.every((x) => x.filled && x.verified);
  const detail = results
    .map((x) => '#' + x.num + ' ' + (x.filled ? (x.verified ? '✔' : '⚠ ' + x.detail) : '✖ ' + x.error))
    .join('  ');
  showMsg('qMsg', (allOk ? '填写并校验通过：' : '填写结果：') + detail, allOk ? 'ok' : 'info');
  log('填写：' + detail, allOk ? 'ok' : 'warn');
}

function doSubmit() {
  showMsg('qMsg', '提交需要在学习通页面手动点击「提交」并确认。本面板不代点，避免误提交。', 'info');
  log('已提示：提交请手动完成', 'warn');
}

// ---------------------------------------------------------------- 环境
async function pollEnv() {
  try {
    const s = await App.visionStatus();
    $('envDsh').textContent = s.dshFound ? '已找到' : '未找到（视觉不可用）';
    $('envKey').textContent = s.hasKey ? '已配置' : '缺失';
    $('envDsh').style.color = s.dshFound ? '#4ade80' : '#f28b82';
    $('envKey').style.color = s.hasKey ? '#4ade80' : '#f28b82';
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 初始化
function init() {
  if (!App) {
    document.body.innerHTML = '<div style="padding:20px;color:#f28b82">preload 未加载，无法与控制进程通信</div>';
    return;
  }
  bindRunnerButtons();
  $('qScan').onclick = doScan;
  $('qAnalyze').onclick = doAnalyze;
  $('qFill').onclick = doFill;
  $('qSubmit').onclick = doSubmit;

  App.onLog((line) => log(line.text || line, line.kind || ''));

  log('控制面板已就绪', 'ok');
  pollEnv();
  pollPage();
  pollRunner();
  pollQuiz();

  setInterval(pollPage, 1500);
  setInterval(pollRunner, 1200);
  setInterval(pollQuiz, 3000);
  setInterval(pollEnv, 15000);
}

init();
