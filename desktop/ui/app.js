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
$('btnHome').onclick = () => App.home();
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
  if (!window.__cxHost) return { ok:false, reason:'App接口未就绪，请刷新后重试' };
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  var results = [];
  var map = {};
  for (var i = 0; i < quiz.questions.length; i++) {
    var q = quiz.questions[i];
    var id = 'q_' + (i + 1);
    if (q.missingLetters || q.type === 'blank' || q.type === 'unknown') { results.push({ id:id, num:q.num, ok:false, error:'题型或选项不支持，请人工处理' }); continue; }
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
      $('qAuto').disabled = quizBusy;
    } else {
      $('qInfo').textContent = '请打开章节测验页面';
      $('qAuto').disabled = quizBusy;
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

let quizBusy = false;
$('qAuto').onclick = async () => {
  if (quizBusy) return;
  quizBusy = true;
  $('qAuto').disabled = true;
  try {
  const env = await App.visionStatus();
  if (!env.dshFound || !env.hasKey) return msg('qMsg', !env.dshFound ? '未找到 DeepSeek Harness，请先安装或配置 DSH_CLI。' : '未找到 API Key，请配置用户自己的模型凭据。', 'err');
  msg('qMsg', '正在逐题视觉识别，请稍候…', 'info');
  log('开始一键答题…');
  const t0 = Date.now();
  const r = await App.evalQuiz(ANALYZE_FILL);
  if (!r || !r.ok) return msg('qMsg', '调用失败：' + errText(r), 'err');
  const d = r.result;
  if (!d || !d.ok) return msg('qMsg', (d && d.reason) || '不在章节测验页面', 'err');

  lastAnswers = d.results || [];
  renderAnswers(lastAnswers);

  const okN = lastAnswers.filter((x) => x.ok).length;
  const filledOk = (d.filled || []).filter((x) => x.ok && x.verified).length;
  const secs = Math.round((Date.now() - t0) / 1000);

  let text = '识别 ' + okN + '/' + d.total + ' 题，已填 ' + filledOk + ' 题，用时 ' + secs + ' 秒。';
  text += '\n核对上面的答案后，请在网页里手动点「提交」。';
  msg('qMsg', text, okN ? 'ok' : 'err');
  log('答题完成 ' + okN + '/' + d.total + '，' + secs + 's', okN ? 'ok' : 'err');
  } catch (e) {
    msg('qMsg', '识别失败：' + errText(e), 'err');
  } finally {
    quizBusy = false;
    $('qAuto').disabled = false;
  }
};

$('qSubmit').onclick = () => {
  msg('qMsg', '提交需要你在网页里点「提交」并确认——这是故意设计的，避免误提交整份测验。', 'info');
};

// ---------------------------------------------------------------- 环境
async function pollPage() {
  try {
    const info = await App.pageInfo();
    $('urlBox').textContent = info.error || (info.loading ? '加载中 · ' : '') + (info.url || '');
    $('urlBox').title = info.error || info.url || '';
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 配置读写
// 用户脚本的 Config 把值存在 kv 的 "cxNaturalWatch:cfg.<key>" 下，且是 JSON 字符串。
// 面板直接按同样格式读写，保证两边看到的是同一份配置。
const CFG_PREFIX = 'cxNaturalWatch:cfg.';

function cfgKey(key) {
  return CFG_PREFIX + key;
}

function cfgGet(key, fallback) {
  try {
    const raw = App.kvGet(cfgKey(key), null);
    if (raw === null || raw === undefined) return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return fallback;
  }
}

function cfgSet(key, value) {
  try {
    App.kvSet(cfgKey(key), JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- 自动做题 / 自动提交
function bindQuizToggles() {
  const autoQuiz = $('autoQuiz');
  const autoSubmit = $('nightAutoSubmit');

  if (autoQuiz) {
    autoQuiz.checked = cfgGet('quizGateEnabled', false) === true;
    autoQuiz.onchange = () => {
      const on = autoQuiz.checked === true;
      cfgSet('quizGateEnabled', on);
      log('自动做题：' + (on ? '已开启（本节视频播完先做本章测验）' : '已关闭（只刷视频，跳过章节测验）'), on ? 'ok' : '');
    };
  }

  if (autoSubmit) {
    autoSubmit.checked = cfgGet('quizAutoSubmit', false) === true;
    autoSubmit.onchange = () => {
      const on = autoSubmit.checked === true;
      cfgSet('quizAutoSubmit', on);
      log('自动提交：' + (on ? '已开启' : '已关闭（只填写，等你手动提交）'), on ? 'ok' : '');
    };
  }
}

// ---------------------------------------------------------------- 夜间静默模式
const NIGHT_DELAY_MS = 30000;
let nightCountdownTimer = null;
let nightRunning = false;

function nightButtonText() {
  return nightRunning ? '退出夜间模式' : '开启夜间模式';
}

function stopCountdown() {
  if (nightCountdownTimer) {
    clearInterval(nightCountdownTimer);
    nightCountdownTimer = null;
  }
}

function startCountdown(untilMs) {
  stopCountdown();
  const btn = $('nightBtn');
  const info = $('nightInfo');
  nightCountdownTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
    if (left <= 0) {
      stopCountdown();
      if (info) info.textContent = '已进入夜间静默：网页静音 + 显示器即将关闭';
      return;
    }
    if (btn) btn.textContent = '取消（' + left + ' 秒后关屏）';
    if (info) info.textContent = '倒计时中：' + left + ' 秒后关闭显示器并静音';
  }, 250);
}

function markNightActive(active) {
  nightRunning = active;
  const btn = $('nightBtn');
  if (btn) {
    btn.textContent = nightButtonText();
    btn.className = 'big dark' + (active ? ' on' : '');
  }
}

async function enterNight() {
  const ok = window.confirm(
    '开启夜间模式后会立即做两件事：\n\n' +
      '1) 把网页静音（不改系统音量）\n' +
      '2) 30 秒后关闭显示器\n\n' +
      '同时会自动勾选「自动做题」和「自动提交」，实现无人监管刷课。\n' +
      '想取消，在 30 秒内点「取消（N 秒后关屏）」。\n\n' +
      '继续？'
  );
  if (!ok) return;

  // 夜间模式 = 全自动：自动做题 + 自动提交
  cfgSet('quizGateEnabled', true);
  cfgSet('quizAutoSubmit', true);
  if ($('autoQuiz')) $('autoQuiz').checked = true;
  if ($('nightAutoSubmit')) $('nightAutoSubmit').checked = true;

  const r = await App.nightSchedule(NIGHT_DELAY_MS);
  if (!r || !r.ok) {
    msg('nightMsg', '夜间模式启动失败：' + errText(r), 'err');
    return;
  }

  markNightActive(true);
  startCountdown(r.executeAt || Date.now() + NIGHT_DELAY_MS);
  msg('nightMsg', '已安排：30 秒后关闭显示器并静音。倒计时内可取消。', 'info');
  log('夜间模式已安排，30 秒后执行', 'ok');
}

async function exitNight() {
  stopCountdown();
  const r = await App.nightCancel();
  markNightActive(false);
  const info = $('nightInfo');
  if (info) info.textContent = '关闭显示屏与声音，无人监管继续刷课';
  msg('nightMsg', r && r.ok ? '已退出夜间模式（网页已取消静音）' : '退出时出错：' + errText(r), r && r.ok ? 'ok' : 'err');
  log('已退出夜间模式', '');
}

function bindNight() {
  const btn = $('nightBtn');
  if (!btn) return;
  markNightActive(false);
  btn.onclick = () => {
    if (nightRunning) exitNight();
    else enterNight();
  };

  if (App.onNight) {
    App.onNight((state) => {
      if (state && state.active) {
        if (state.error) {
          msg('nightMsg', '部分步骤失败：' + state.error, 'err');
          log('夜间模式部分失败：' + state.error, 'err');
        } else {
          msg('nightMsg', '已进入夜间静默：网页静音，显示器已关闭', 'ok');
        }
        markNightActive(true);
        stopCountdown();
      }
    });
  }
}

// ---------------------------------------------------------------- 模型设置
async function pollModel() {
  try {
    const s = await App.visionStatus();
    const info = $('modelInfo');
    if (!info) return;
    if (s && s.hasKey) {
      const src = s.keySource === 'app' ? '本 App' : s.keySource === 'env' ? '环境变量' : '本机 DSH';
      info.textContent = '已配置（' + src + '）' + (s.keyMasked ? ' · ' + s.keyMasked : '');
      info.style.color = '#4ade80';
    } else {
      info.textContent = '未配置 API Key —— 不填无法自动答题';
      info.style.color = '#f0b429';
    }
  } catch (e) {
    /* ignore */
  }
}

function bindModel() {
  const save = $('modelSave');
  const test = $('modelTest');
  const clear = $('modelClear');
  const input = $('modelKey');
  if (!save || !input) return;

  save.onclick = async () => {
    const key = String(input.value || '').trim();
    if (!key) return msg('modelMsg', '请先粘贴 API Key', 'err');
    const r = await App.setModelKey(key);
    if (!r || !r.ok) {
      const map = {
        EMPTY_KEY: 'Key 为空',
        ENCRYPTION_UNAVAILABLE: '系统加密不可用，无法安全保存',
      };
      return msg('modelMsg', '保存失败：' + (map[r && r.error] || (r && r.error) || '未知错误'), 'err');
    }
    input.value = '';
    msg('modelMsg', '已保存（加密存储）' + (r.masked ? ' · ' + r.masked : ''), 'ok');
    log('API Key 已保存', 'ok');
    pollModel();
  };

  test.onclick = async () => {
    msg('modelMsg', '正在测试连接…', 'info');
    const r = await App.testModel();
    if (r && r.ok) {
      msg('modelMsg', '连接正常 · ' + (r.elapsedMs || 0) + 'ms · 模型 ' + r.model, 'ok');
      log('模型连接正常', 'ok');
    } else {
      const hints = {
        MISSING_CREDENTIAL: '还没配置 API Key',
        NETWORK_ERROR: '网络不通，检查代理设置',
      };
      const extra = hints[r && r.error] || (r && r.error) || '';
      msg('modelMsg', '连接失败：' + extra + (r && r.detail ? ' · ' + r.detail : ''), 'err');
    }
  };

  clear.onclick = async () => {
    if (!window.confirm('确定清除已保存的 API Key？清除后无法自动答题。')) return;
    await App.clearModelKey();
    msg('modelMsg', '已清除', 'info');
    pollModel();
  };
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
  bindQuizToggles();
  bindNight();
  bindModel();
  pollModel();
  pollPage();
  pollRunner();
  pollQuiz();

  setInterval(pollPage, 1500);
  setInterval(pollRunner, 1200);
  setInterval(pollQuiz, 4000);
  setInterval(pollModel, 20000);
}

init();
