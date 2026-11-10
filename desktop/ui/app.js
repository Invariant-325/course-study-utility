// ---------------------------------------------------------------------------
// app.js —— 控制面板（小白化）
// ---------------------------------------------------------------------------
const App = window.__cxApp;
const $ = (id) => document.getElementById(id);

function log(text, kind) {
  const box = $('log');
  if (!box) return;
  const d = document.createElement('div');
  if (kind) d.className = kind;
  d.textContent = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + text;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  while (box.childNodes.length > 200) box.removeChild(box.firstChild);
}

function msg(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'msg' + (text ? ' show ' : ' ') + (kind || 'info');
}

function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.error || e.reason || e.message || JSON.stringify(e);
}

// ---------------------------------------------------------------- 顶部导航
$('btnHome').onclick = () => App.goto('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu');
$('btnBack').onclick = () => App.back();
$('btnReload').onclick = () => App.reload();

// ---------------------------------------------------------------- 视频状态
const STATE_TEXT = {
  idle: '待机',
  locating: '定位任务点',
  playing: '正在播放',
  settling: '等待平台确认',
  awaitingConfirm: '等待平台确认',
  advancing: '切换下一节',
  paused: '已暂停',
  blocked: '需要人工处理',
  needsReview: '需要复核',
  completed: '全部完成',
  stopped: '已停止',
  quizWait: '检测到弹题',
};

let mounted = false;

async function readRunner() {
  try {
    const r = await App.evalMain(`(function(){
      var a = window.__cxNaturalWatchApp;
      if (!a || !a.runner) return { mounted:false };
      try { return { mounted:true, snap: a.runner.snapshot() }; } catch(e) { return { mounted:false }; }
    })()`);
    if (!r || !r.ok) return { mounted: false };
    return r.result || { mounted: false };
  } catch (e) {
    return { mounted: false };
  }
}

async function pollRunner() {
  const d = await readRunner();
  mounted = !!d.mounted;

  if (!mounted) {
    $('vState').textContent = '未在课程学习页';
    $('vState').className = 'state off';
    $('vJob').textContent = '请在左侧登录后打开课程 → 进入章节学习页';
    $('vProgBar').style.width = '0%';
    $('vCount').textContent = '';
    $('vStart').disabled = true;
    $('vStart').textContent = '请先进入课程学习页';
    return;
  }

  const s = d.snap || {};
  const state = s.state || 'idle';
  $('vState').textContent = STATE_TEXT[state] || s.stateLabel || state;
  $('vState').className =
    'state' + (state === 'playing' || state === 'completed' ? '' : state === 'blocked' || state === 'needsReview' ? ' warn' : '');

  $('vJob').textContent = s.jobTitle ? s.jobTitle + (s.jobType ? '（' + s.jobType + '）' : '') : '—';

  const v = s.video || {};
  const pct = v.duration > 0 ? Math.min(100, Math.round(((v.currentTime || 0) / v.duration) * 100)) : 0;
  $('vProgBar').style.width = pct + '%';
  $('vCount').textContent =
    pct + '% · 已确认 ' + (s.confirmedCount || 0) + ' 个 · 待完成 ' + (s.pendingCount || 0) + ' 个';

  const running = ['playing', 'settling', 'awaitingConfirm', 'advancing', 'locating'].indexOf(state) !== -1;
  $('vStart').disabled = running;
  $('vStart').textContent = running ? '正在刷课…' : state === 'paused' ? '继续刷课' : '开始自动刷课';
}

async function runnerCall(name) {
  const r = await App.evalMain(`(function(){
    var a = window.__cxNaturalWatchApp;
    if (!a || !a.runner) return { ok:false, reason:'not-mounted' };
    try { a.runner.${name}(); return { ok:true }; } catch(e) { return { ok:false, reason:String(e && e.message) }; }
  })()`);
  if (!r || !r.ok) return { ok: false, reason: '调用通道失败' };
  return r.result || { ok: false };
}

$('vStart').onclick = async () => {
  const res = await runnerCall('start');
  if (res.ok) {
    msg('vMsg', '已开始，切换到后台也会继续。', 'ok');
    log('开始自动刷课', 'ok');
  } else {
    msg('vMsg', '启动失败：' + errText(res), 'err');
  }
  pollRunner();
};

$('vPause').onclick = async () => {
  const res = await runnerCall('pause');
  msg('vMsg', res.ok ? '已暂停（真实暂停，没有伪造进度）' : '暂停失败：' + errText(res), res.ok ? 'info' : 'err');
  pollRunner();
};

$('vStop').onclick = async () => {
  const res = await runnerCall('stop');
  msg('vMsg', res.ok ? '已停止' : '停止失败：' + errText(res), res.ok ? 'info' : 'err');
  pollRunner();
};

// ---------------------------------------------------------------- 答题
let lastAnswers = [];

const SCAN = `(function(){
  if (!window.__cxChapterQuiz) return { ok:false, reason:'no-api' };
  var q = window.__cxChapterQuiz.adapter.parse(document);
  return { ok:true, count:q.count, encrypted:q.encryptedCount };
})()`;

const ANALYZE_FILL = `(async function(){
  var api = window.__cxChapterQuiz;
  if (!api) return { ok:false, reason:'no-api' };
  var quiz = api.adapter.parse(document);
  if (!quiz.count) return { ok:false, reason:'no-questions' };
  var results = [];
  var map = {};
  for (var i = 0; i < quiz.questions.length; i++) {
    var q = quiz.questions[i];
    var id = 'q_' + (i + 1);
    if (!q.encrypted) { results.push({ id:id, num:q.num, ok:false, error:'题目未加密，暂不支持' }); continue; }
    var img = api.image.render(q);
    if (!img.ok) { results.push({ id:id, num:q.num, ok:false, error:'出图失败:' + img.reason }); continue; }
    if (img.unsupported && img.unsupported.length) { results.push({ id:id, num:q.num, ok:false, error:'含图片/公式，需人工' }); continue; }
    var letters = q.options.map(function(o){ return o.letter; });
    var r = await window.__cxHost.askVision({ questionId:id, imageBase64:img.dataUrl, allowedLetters:letters });
    if (r && r.ok && r.answers && r.answers.length) {
      results.push({ id:id, num:q.num, ok:true, answers:r.answers });
      map[id] = r.answers;
    } else {
      results.push({ id:id, num:q.num, ok:false, error:(r && r.error) || '识别失败' });
    }
  }
  var filled = [];
  for (var k = 0; k < quiz.questions.length; k++) {
    var qq = quiz.questions[k];
    var qid = 'q_' + (k + 1);
    if (!map[qid]) continue;
    var f = api.adapter.fill(qq, map[qid], { force:false, source:'vision' });
    var v = api.adapter.verify(qq, map[qid]);
    filled.push({ num:qq.num, ok:f.ok, verified:v.ok, err:(f.errors||[]).join(',') });
  }
  return { ok:true, results: results, filled: filled, total: quiz.count };
})()`;

function renderAnswers(list) {
  const box = $('qList');
  box.textContent = '';
  for (const it of list) {
    const d = document.createElement('div');
    d.className = 'qitem';
    const h = document.createElement('div');
    h.className = 'qh';
    h.textContent = '第 ' + it.num + ' 题';
    d.appendChild(h);
    const a = document.createElement('div');
    if (it.ok) {
      a.className = 'qa';
      a.textContent = (it.answers || []).join(' , ');
    } else {
      a.className = 'qe';
      a.textContent = it.error || '未识别';
    }
    d.appendChild(a);
    box.appendChild(d);
  }
}

async function pollQuiz() {
  try {
    const r = await App.evalQuiz(SCAN);
    if (r && r.ok && r.result && r.result.ok) {
      $('qInfo').textContent = '识别到 ' + r.result.count + ' 道题（加密 ' + r.result.encrypted + ' 道）';
      $('qAuto').disabled = false;
    } else {
      $('qInfo').textContent = '请打开章节测验页面';
      $('qAuto').disabled = false; // 允许点击后给出提示
    }
  } catch (e) {
    /* ignore */
  }
}

$('qScan').onclick = async () => {
  const r = await App.evalQuiz(SCAN);
  if (!r || !r.ok) return msg('qMsg', '不在测验页，或页面还没加载完', 'err');
  const d = r.result;
  if (!d || !d.ok) return msg('qMsg', d && d.reason === 'no-api' ? '脚本未注入，请刷新页面' : '不在章节测验页面', 'err');
  msg('qMsg', '找到 ' + d.count + ' 道题', 'ok');
  pollQuiz();
};

$('qAuto').onclick = async () => {
  msg('qMsg', '正在识别（每题约 4-5 秒，请稍候）…', 'info');
  log('开始一键答题…');
  const t0 = Date.now();
  const r = await App.evalQuiz(ANALYZE_FILL);
  if (!r || !r.ok) return msg('qMsg', '调用失败：' + errText(r), 'err');
  const d = r.result;
  if (!d || !d.ok) return msg('qMsg', '不在章节测验页面', 'err');

  lastAnswers = d.results || [];
  renderAnswers(lastAnswers);

  const okN = lastAnswers.filter((x) => x.ok).length;
  const filledOk = (d.filled || []).filter((x) => x.ok && x.verified).length;
  const secs = Math.round((Date.now() - t0) / 1000);

  let text = '识别 ' + okN + '/' + d.total + ' 题，已填 ' + filledOk + ' 题，用时 ' + secs + ' 秒。';
  text += '\n核对上面的答案后，请在网页里手动点「提交」。';
  msg('qMsg', text, okN ? 'ok' : 'err');
  log('答题完成 ' + okN + '/' + d.total + '，' + secs + 's', okN ? 'ok' : 'err');
};

$('qSubmit').onclick = () => {
  msg('qMsg', '提交需要你在网页里点「提交」并确认——这是故意设计的，避免误提交整份测验。', 'info');
};

// ---------------------------------------------------------------- 环境
async function pollEnv() {
  try {
    const s = await App.visionStatus();
    $('envDsh').textContent = s.dshFound ? '已就绪' : '未找到（答题不可用）';
    $('envDsh').style.color = s.dshFound ? '#4ade80' : '#f28b82';
    $('envKey').textContent = s.hasKey ? '已配置' : '缺失';
    $('envKey').style.color = s.hasKey ? '#4ade80' : '#f28b82';
  } catch (e) {
    /* ignore */
  }
}

async function pollPage() {
  try {
    const info = await App.pageInfo();
    $('urlBox').textContent = info.url || '';
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 版本
async function showVersion() {
  try {
    const info = await App.appInfo();
    $('verText').textContent = '版本 ' + info.version + (info.isPackaged ? '' : '（开发）');
    $('verText').title = '安装位置：' + info.exePath + '\n数据目录：' + info.userData;
  } catch (e) {
    $('verText').textContent = '版本未知';
  }
}

function bindUpdate() {
  const btn = $('btnUpdate');
  if (!btn) return;
  btn.onclick = () => {
    msg(
      'qMsg',
      '本工具是个人第三方兼容程序，并非学习通或超星官方产品，与超星平台无隶属、授权、合作或背书关系。\n' +
        '没有自动更新功能。请退出旧版后运行新安装包覆盖安装；本地数据通常保留，平台登录有效性由平台决定。',
      'info'
    );
    log('更新说明：退出旧版 → 运行新安装包 → 核对版本与本地数据', '');
  };
}

// ---------------------------------------------------------------- 初始化
function init() {
  if (!App) {
    document.body.innerHTML = '<div style="padding:24px;color:#f28b82">控制进程未就绪，请重启应用</div>';
    return;
  }
  App.onLog((line) => log(line.text || line, line.kind || ''));
  log('就绪。请登录课程平台，然后进入课程学习页。', 'ok');

  showVersion();
  bindUpdate();
  pollEnv();
  pollPage();
  pollRunner();
  pollQuiz();

  setInterval(pollPage, 1500);
  setInterval(pollRunner, 1200);
  setInterval(pollQuiz, 4000);
  setInterval(pollEnv, 20000);
}

init();
