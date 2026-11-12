// ---------------------------------------------------------------------------
// main.js —— 学习通桌面助手 V0.1
//
// 小白化设计：
//   打开 → 中间是学习通（自己登录）→ 右侧只有「开始自动刷课 / 暂停 / 停止」
//   自动刷课时窗口可以最小化到后台，chromium 不节流。
//
// 结构：
//   BrowserWindow 显示控制面板 UI（ui/index.html）
//   WebContentsView 嵌入真实学习通页面（session 持久化，单独登录）
//   用户脚本通过 GM 适配层注入每个 frame
//   视觉识别由主进程直接调用 dsh headless（无需外部服务）
// ---------------------------------------------------------------------------
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const electron = require('electron');
if (!electron || typeof electron !== 'object' || !electron.app) {
  console.error('GUI startup requires Electron. Clear ELECTRON_RUN_AS_NODE and launch again.');
  process.exit(1);
}
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, dialog, safeStorage, Tray, Notification, nativeImage } = electron;
const { createCourseBrowser } = require("./course-browser.cjs");
const { retainLogin } = require("./login-session.cjs");
const { isPlatformUrl } = require("./browser-policy.cjs");
const { installFrameBridge } = require("./frame-bridge.cjs");
const sleepGuard=require('./sleep-guard.cjs').createSleepGuard(electron.powerSaveBlocker);
app.on('before-quit',()=>sleepGuard.close());
// Preserve the established data directory across the display-name change.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const legacyData = path.join(app.getPath('appData'), 'chaoxing-helper-desktop');
  fs.mkdirSync(legacyData, { recursive: true });
  app.setPath('userData', legacyData);
}
// Electron includes this internal name in User-Agent. Keep it ASCII for web SDK encoding.
// Localized window titles, installer metadata and shortcuts retain the product name.
app.setPath('sessionData', app.getPath('userData'));
app.setName('CourseStudyUtility');
const BOOT_LOG = path.join(app.getPath('userData'), 'logs', 'startup.log');
function bootLog(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    if (fs.existsSync(BOOT_LOG) && fs.statSync(BOOT_LOG).size > 1024 * 1024) {
      fs.renameSync(BOOT_LOG, BOOT_LOG + '.previous');
    }
    fs.appendFileSync(BOOT_LOG, line + '\n');
  } catch (e) {
    console.error('[startup-log]', e.message);
  }
}
function fatalStartup(error) {
  const detail = String(error && (error.stack || error.message) || error);
  bootLog('fatal: ' + detail);
  console.error(detail);
  dialog.showErrorBox('课程伴学工具启动失败', '程序启动失败，详情已记录到：\n' + BOOT_LOG + '\n\n' + detail);
  app.exit(1);
}
process.on('uncaughtException', fatalStartup);
process.on('unhandledRejection', (e) => {
  bootLog('unhandled: ' + String(e && (e.stack || e.message) || e));
  console.error(e);
});
bootLog('boot; version=' + app.getVersion() + '; electron=' + process.versions.electron);

// 退出标志必须在任何 close 处理器之前声明：
// 之前写在文件末尾，窗口关闭时命中 TDZ 直接抛 ReferenceError。
let isQuitting = false;

let win = null;
let browser = null;
let coursePortal = null;
let playbackController=null,manualQuiz=null,chapterQuizBridge=null,questionCapture=null;
const { createCoursePortal } = require('./course-portal.cjs');
const { cleanChapterTitle } = require('./chapter-title.cjs');
let loginSession = null;
let closingWindow = false;
let store = {};
let storeFile = '';
let saveTimer = null;

// ---------------------------------------------------------------- 持久化 KV
function loadStore() {
  storeFile = path.join(app.getPath('userData'), 'store.json');
  try {
    store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  } catch (e) {
    store = {};
  }
}

function saveStore() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
      bootLog('store save failed: ' + e.message);
    }
  }, 300);
}

// ---------------------------------------------------------------- 用户脚本
function loadUserscript() {
  const candidates = [
    path.join(__dirname, 'userscript', 'chaoxing-helper.user.js'),
    path.join(__dirname, '..', 'chaoxing-helper', 'dist', 'chaoxing-helper.user.js'),
    path.join(__dirname, '..', '..', 'chaoxing-helper', 'dist', 'chaoxing-helper.user.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch (e) {
      /* ignore */
    }
  }
  return '';
}

const GM_SHIM = `
(function(){
  if (window.__cxGMInstalled) return;
  window.__cxGMInstalled = true;
  var H = window.__cxHost;
  window.GM_getValue = function(k, d){ try { return H ? H.kvGet(k, d) : d; } catch(e){ return d; } };
  window.GM_setValue = function(k, v){ try { if (H) H.kvSet(k, v); } catch(e){} };
  window.GM_deleteValue = function(k){ try { if (H) H.kvSet(k, null); } catch(e){} };
  window.GM_registerMenuCommand = function(name){ try { if (H) H.registerMenu(name); } catch(e){} };
  window.GM_setClipboard = function(t){ try { navigator.clipboard.writeText(String(t)); } catch(e){} };
  window.GM_xmlhttpRequest = function(opts){
    opts = opts || {};
    if (!H) { try { opts.onerror && opts.onerror({ error: 'host-unavailable' }); } catch(e){} return; }
    H.xhr({ method: opts.method || 'GET', url: opts.url, headers: opts.headers || {}, data: opts.data, timeout: opts.timeout || 120000 })
      .then(function(res){
        try {
          if (res && res.error) { opts.onerror && opts.onerror(res); }
          else { opts.onload && opts.onload({ status: res.status, responseText: res.text, response: res.text }); }
        } catch(e){}
      })
      .catch(function(e){ try { opts.onerror && opts.onerror({ error: String(e) }); } catch(_){} });
  };
})();
`;

let injectCode = '';

function buildInjectCode(userscript) {
  return `
(function(){
  if (window.__cxUserscriptLoaded) return;
  window.__cxUserscriptLoaded = true;
  // 告诉用户脚本：这次是 App 内注入，网页里不要再挂自己的面板
  window.__CX_IN_APP__ = true;
  try {
${GM_SHIM}
  } catch (e) { console.error('[cx] gm shim failed', e); }
  try {
${userscript}
  } catch (e) { console.error('[cx] userscript failed', e); }
})();
`;
}

function collectFrames(frame, out) {
  const seen = new Set(out);
  const queue = [frame];
  while (queue.length && out.length < 256) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    try { queue.push(...current.frames); } catch (e) { /* frame may detach */ }
  }
}

let courseChangedTimer;
function notifyCourseChanged(){clearTimeout(courseChangedTimer);courseChangedTimer=setTimeout(()=>{if(win&&!win.isDestroyed())win.webContents.send('course:changed');},100);}
function injectAllFrames(wc) {
  if (!wc || wc.isDestroyed() || !injectCode || !isPlatformUrl(wc.getURL())) return;
  const frames = [];
  try { collectFrames(wc.mainFrame, frames); } catch { return; }
  const topOrigin = new URL(wc.getURL()).origin;
  const frameSetup = '(' + installFrameBridge.toString() + ')(' + JSON.stringify(topOrigin) + ',' + JSON.stringify(store) + ');';
  for (const frame of frames) {
    try {
      if (!isPlatformUrl(frame.url)) continue;
      frame.executeJavaScript(frameSetup + injectCode, true).then(notifyCourseChanged).catch(() => bootLog('frame-injection-retry-needed'));
    } catch { /* navigation may detach the frame */ }
  }
}

function flushStore() {
  clearTimeout(saveTimer);
  if (!storeFile) return;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), 'utf8');
}

async function createWindow() {
  const persist = session.fromPartition('persist:chaoxing');
  loginSession = await retainLogin(persist, app.getPath('userData'), safeStorage, bootLog);
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 680,
    title: '课程伴学工具',
    // 只隐藏标题栏，保留系统窗口边框：标题栏由页面自绘。
    // 不用 frame:false —— 它和 backgroundMaterial:'mica' 同时出现会让窗口创建失败。
    titleBarStyle: 'hidden',
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    webPreferences: { icon:path.join(__dirname,'build/icon.ico'),preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html')).catch(fatalStartup);
  // The local control panel never navigates; About links use the explicit,
  // allowlisted app:external handler instead of renderer-created popups.
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.on('will-redirect',event=>event.preventDefault());
  win.webContents.on('will-frame-navigate',event=>event.preventDefault());
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('did-finish-load', () => bootLog('control-panel-loaded'));
  win.webContents.on('render-process-gone', (_event, details) => bootLog('panel-process-gone: ' + details.reason));
  browser = createCourseBrowser({ win, WebContentsView, ses: persist,
    preload: path.join(__dirname, 'preload.js'), inject: injectAllFrames, log: bootLog,defaultMuted:store.defaultWebMuted===true });
  // Use the portal's own course-menu handler after normal platform login.
  coursePortal = createCoursePortal({ browser,getStrategy:()=>{try{return JSON.parse(store['cxNaturalWatch:cfg.studyStrategy']||'"auto"')}catch{return 'auto'}},onActivity:active=>sleepGuard.set('runner',active) });
  playbackController=require('./playback-controller.cjs').createPlaybackController({browser,portal:coursePortal});
  questionCapture=require('./question-capture.cjs').createQuestionCapture({browser});
  chapterQuizBridge=require('./chapter-quiz-bridge.cjs').createChapterQuizBridge({browser,getPreferences:()=>({quizGateEnabled:store['cxNaturalWatch:cfg.quizGateEnabled']==='true',quizAutoSubmit:store['cxNaturalWatch:cfg.quizAutoSubmit']==='true'})});
  manualQuiz=require('./manual-quiz.cjs').createManualQuiz({browser,portal:coursePortal,playback:playbackController});
  coursePortal.refresh().catch(() => bootLog('course-list-unavailable'));
  win.on('close', event => {
    // 收起窗口 = 收进托盘（不退出），这样刷课能继续
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
      bootLog('window-hidden-to-tray');
      return;
    }
    if (closingWindow) return;
    event.preventDefault();
    closingWindow = true;
    (async () => {
      try { flushStore(); await loginSession.flush(); }
      catch { bootLog('close-save-failed'); }
      try { coursePortal?.close(); browser.close(); } catch (e) {}
      win.destroy();
    })();
  });
  win.on('closed', () => { win = null; browser = null; });
  return win;
}

// ---------------------------------------------------------------- 视觉调用
function dshCandidates() {
  const list = [];
  if (process.env.DSH_CLI) list.push(process.env.DSH_CLI);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  list.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  list.push(path.join(local, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  return list;
}

function findDshCli() {
  for (const p of dshCandidates()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {
      /* ignore */
    }
  }
  return '';
}

function dshHomeDir() {
  const dir = path.join(app.getPath('userData'), 'dsh-home');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
  return dir;
}

// ---------------- 模型凭据 ----------------
// 优先级：用户在本 App 里填的（safeStorage 加密存盘）> 环境变量 > 本机 DSH 凭据（兼容老用户）
// 目的：普通用户不需要装 DSH、不需要改配置文件。
const MODEL_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

function credentialsFile() {
  return path.join(app.getPath('userData'), 'credentials.bin');
}

function loadStoredKey() {
  try {
    const f = credentialsFile();
    if (!fs.existsSync(f)) return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    return String(safeStorage.decryptString(fs.readFileSync(f)) || '');
  } catch (e) {
    return '';
  }
}

function storeKey(key) {
  const value = String(key || '').trim();
  if (!value) return { ok: false, error: 'EMPTY_KEY' };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'ENCRYPTION_UNAVAILABLE' };
  try {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    fs.writeFileSync(credentialsFile(), safeStorage.encryptString(value));
    bootLog('[credential] stored (' + value.length + ' chars)');
    return { ok: true, masked: maskKey(value) };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

function clearStoredKey() {
  try {
    fs.rmSync(credentialsFile(), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 8) return k ? '****' : '';
  return k.slice(0, 3) + '****' + k.slice(-4);
}

function resolveApiKey() {
  const stored = loadStoredKey();
  if (stored) return stored;
  if (process.env.VISION_API_KEY) return process.env.VISION_API_KEY;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml'),
  ];
  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
      if (m) return m[1] || m[2] || m[3] || '';
    } catch (e) {
      /* ignore */
    }
  }
  return '';
}

function keySource() {
  if (loadStoredKey()) return 'app';
  if (process.env.VISION_API_KEY || process.env.DEEPSEEK_API_KEY) return 'env';
  return resolveApiKey() ? 'dsh' : '';
}

const SYSTEM_TASK = [
  '你是一个视觉题目分析引擎。',
  '你的任务是根据提供的题目截图，识别题目内容，并输出候选答案。',
  '规则：',
  '1. 支持单选、多选和判断题。',
  '2. 必须根据图片中的实际题目和选项进行分析。',
  '3. 不得编造图片中不存在的选项。',
  '4. 图片模糊、截断、存在歧义时返回无法识别。',
  '5. 只输出合法 JSON，不输出 Markdown、代码围栏、前言或额外说明。',
  '6. 选项使用图片中对应的 A、B、C、D 等标识。',
  '7. 不确定时允许返回 null，不得强行猜测。',
  '8. 仅允许使用图片查看或只读文件工具读取指定题目截图；不执行命令，不操作网页，不修改任何文件。',
  '',
  '统一返回格式：',
  '{"type":"single","answers":["B"],"status":"ok"}',
].join('\n');

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty');
  let body = raw;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no-json');
  return JSON.parse(body.slice(start, end + 1));
}

function runHeadless(task, timeoutMs) {
  return new Promise((resolve) => {
    const cli = findDshCli();
    if (!cli) return resolve({ code: -10, stdout: '', stderr: 'no-dsh' });

    const tmp = path.join(app.getPath('temp'), 'cx-vision');
    fs.mkdirSync(tmp, { recursive: true });
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const taskFile = path.join(tmp, 'task-' + stamp + '.txt');
    const outFile = path.join(tmp, 'out-' + stamp + '.txt');
    const errFile = path.join(tmp, 'err-' + stamp + '.txt');
    fs.writeFileSync(taskFile, task, 'utf8');

    let child;
    try {
      const inFd = fs.openSync(taskFile, 'r');
      const outFd = fs.openSync(outFile, 'w');
      const errFd = fs.openSync(errFile, 'w');
      const cliDir = path.dirname(cli);
      const host = path.resolve(cliDir, '../../../../DeepSeek Harness.exe');
      const entry = path.resolve(cliDir, '../../../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
      const nativeHost = fs.existsSync(host) && fs.existsSync(entry);
      const args = ['--profile', 'headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'];
      child = spawn(nativeHost ? host : (process.env.ComSpec || 'cmd.exe'),
        nativeHost ? ['--expose-internals', entry, ...args] : ['/d', '/s', '/c', '""' + cli + '" ' + args.join(' ') + '"'],
        {
          cwd: app.getPath('userData'),
          env: Object.assign({}, process.env, { DSH_HOME: dshHomeDir(), DEEPSEEK_API_KEY: resolveApiKey(), ELECTRON_RUN_AS_NODE: '1' }),
          stdio: [inFd, outFd, errFd],
          windowsHide: true,
          windowsVerbatimArguments: !nativeHost,
        }
      );
      child.on('exit', () => {
        try { fs.closeSync(inFd); } catch (e) {}
        try { fs.closeSync(outFd); } catch (e) {}
        try { fs.closeSync(errFd); } catch (e) {}
      });
    } catch (e) {
      return resolve({ code: -11, stdout: '', stderr: e.message });
    }

    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      const read = (p) => {
        try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch (e) { return ''; }
      };
      const out = read(outFile);
      const err = read(errFile);
      for (const f of [taskFile, outFile, errFile]) {
        try { fs.rmSync(f, { force: true }); } catch (e) {}
      }
      resolve({ code, stdout: out, stderr: err });
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      finish(-1);
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(-2); });
    child.on('exit', (code) => { clearTimeout(timer); finish(code === null ? -3 : code); });
  });
}

async function askVision(payload) {
  const questionId = String((payload && payload.questionId) || '').slice(0, 512);
  const imageBase64 = String((payload && payload.imageBase64) || '');
  const allowedLetters = Array.isArray(payload && payload.allowedLetters)
    ? payload.allowedLetters.map((x) => String(x).toUpperCase()).slice(0, 8)
    : [];

  if (!questionId || /[\x00-\x1f]/.test(questionId)) {
    return { ok: false, status: 'unreadable', error: 'INVALID_QUESTION_ID' };
  }
  if (!resolveApiKey()) return { ok: false, status: 'unreadable', error: 'MISSING_CREDENTIAL' };

  const raw = imageBase64.replace(/^data:image\/[a-z]+;base64,/i, '');
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (e) {
    return { ok: false, status: 'unreadable', error: 'INVALID_BASE64' };
  }
  if (!buf || buf.length < 100) return { ok: false, status: 'unreadable', error: 'IMAGE_EMPTY' };
  if (buf.length > 8 * 1024 * 1024) return { ok: false, status: 'unreadable', error: 'IMAGE_TOO_LARGE' };
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w > 4096 || h > 4096) return { ok: false, status: 'unreadable', error: 'IMAGE_DIMENSION_EXCEEDED' };
  }

  const started = Date.now();

  // 直连 DeepSeek（OpenAI 兼容）——不需要用户安装 DSH。
  // 提示词内置，图片以 data URL 内联，返回严格 JSON。
  let modelText = '';
  let usage = {};
  try {
    const res = await fetch(MODEL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + resolveApiKey(),
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_TASK },
          {
            role: 'user',
            content: [
              { type: 'text', text:'请直接阅读网页截图中的题目并作答。允许的选项标识：'+allowedLetters.join('、')+'。只返回 type、answers、status 三个 JSON 字段。' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + buf.toString('base64') } },
            ],
          },
        ],
        max_tokens: 400,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const text = await res.text();
    const elapsedMs = Date.now() - started;

    if (!res.ok) {
      const safe = String(text || '').replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***').slice(0, 300);
      return { ok: false, status: 'unreadable', error: 'HTTP_' + res.status, detail: safe, elapsedMs };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, status: 'unreadable', error: 'INVALID_RESPONSE', elapsedMs };
    }

    usage = (json && json.usage) || {};
    const content =
      json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    modelText = content || '';
    if (!modelText) return { ok: false, status: 'unreadable', error: 'EMPTY_CONTENT', elapsedMs };
  } catch (e) {
    return {
      ok: false,
      status: 'unreadable',
      error: 'NETWORK_ERROR',
      detail: String((e && e.message) || e).slice(0, 200),
      elapsedMs: Date.now() - started,
    };
  }

  const elapsedMs = Date.now() - started;

  let parsed;
  try {
    parsed = extractJson(modelText);
  } catch (e) {
    return { ok: false, status: 'unreadable', error: 'PARSE_FAILED', elapsedMs };
  }

  const errors = [];
  // The request closure owns question identity. Model-generated identifiers never route answers.
  // Browser-side validation still requires this original host-bound ID to match. 
  let answers = Array.isArray(parsed.answers) ? parsed.answers.map((x) => String(x).toUpperCase()) : [];
  answers = answers.filter((a) => /^[A-H]$/.test(a));
  const allowed = new Set(allowedLetters);
  if (allowed.size) {
    const bad = answers.filter((a) => !allowed.has(a));
    if (bad.length) errors.push('选项不存在:' + bad.join(','));
    answers = answers.filter((a) => allowed.has(a));
  }
  answers = Array.from(new Set(answers));
  const type = String(parsed.type || 'unknown').toLowerCase();
  const status = String(parsed.status || 'unreadable').toLowerCase();
  if ((type === 'single' || type === 'true_false' || type === 'judge') && answers.length > 1) answers = answers.slice(0, 1);

  return {
    ok: errors.length === 0 && status === 'ok' && answers.length > 0,
    status, type, answers, errors, questionId, elapsedMs,
    usage: {
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
    },
  };
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('playback:status',async()=>{const value=playbackController?await playbackController.status():{ok:false};sleepGuard.set('playback',['playing','preparing','working'].includes(value.mode));return value;});
  ipcMain.handle('playback:command',async(_e,action)=>{if(action==='pause'||action==='stop')await manualQuiz?.cancel();else if(manualQuiz?.status().busy)return {ok:false,error:'正在做本章习题，暂停后再开始学习'};return playbackController?playbackController.command(action):{ok:false,error:'页面尚未就绪'};});
  ipcMain.handle('quiz:capture',async(event,request)=>{if(event.sender!==browser?.view?.webContents||!isPlatformUrl(event.senderFrame?.url))return {ok:false,reason:'不支持的截图来源'};return questionCapture?questionCapture.capture(request):{ok:false,reason:'截图接口未就绪'};});
  ipcMain.handle('quiz:chapter',async(event,request)=>{if(event.sender!==browser?.view?.webContents||!isPlatformUrl(event.senderFrame?.url))return {ok:false,error:'不支持的来源'};return chapterQuizBridge?chapterQuizBridge.invoke(request):{ok:false};});
  ipcMain.handle('quiz:manual',async(_e,chapter)=>{if(!manualQuiz)return {ok:false,error:'先打开课程'};if(manualQuiz.status().busy)return {ok:false,error:'正在做题，请等待完成'};sleepGuard.set('manual-quiz',true);try{return await manualQuiz.start(chapter)}finally{sleepGuard.set('manual-quiz',false)}});
  ipcMain.handle('quiz:manualStatus',()=>manualQuiz?.status()||{busy:false});
  ipcMain.handle('learning:preferences',async (_event,patch)=>{
    const keys=['quizGateEnabled','quizAutoSubmit','studyStrategy','advanceOnPlatformComplete'];
    const modes=['auto','sequential','quiz-first','quiz-only','video-only'];
    const values={};
    for(const key of keys){let value=store['cxNaturalWatch:cfg.'+key];try{value=typeof value==='string'?JSON.parse(value):value}catch{value=undefined}values[key]=key==='studyStrategy'?(modes.includes(value)?value:'auto'):key==='advanceOnPlatformComplete'?value!==false:value===true;}
    if(patch){
      for(const key of keys){const v=patch[key];if(key==='studyStrategy'?modes.includes(v):typeof v==='boolean')values[key]=v;}
      for(const key of keys)store['cxNaturalWatch:cfg.'+key]=JSON.stringify(values[key]);saveStore();
      const frames=[];if(browser?.view)collectFrames(browser.view.webContents.mainFrame,frames);
      await Promise.all(frames.filter(f=>isPlatformUrl(f.url)).map(f=>f.executeJavaScript(`(()=>{const c=window.__cxNaturalWatchApp?.config;if(c)for(const [k,v] of Object.entries(${JSON.stringify(values)}))c.set(k,v);return true})()`).catch(()=>false)));
    }
    return values;
  });
  const externalBase='https://github.com/Invariant-325';
  ipcMain.handle('app:external',async (_e,url)=>{let u;try{u=new URL(url)}catch{return{ok:false}}if(u.origin!=='https://github.com'||u.username||u.password||!(u.pathname==='/Invariant-325'||u.pathname==='/Invariant-325/course-study-utility'||u.pathname.startsWith('/Invariant-325/course-study-utility/')))return{ok:false};await electron.shell.openExternal(u.href);return{ok:true}});
  ipcMain.handle('app:preferences',(_e,patch)=>{if(patch&&typeof patch.defaultWebMuted==='boolean'){store.defaultWebMuted=patch.defaultWebMuted;browser?.setMuted(patch.defaultWebMuted)}if(patch&&typeof patch.autoCheckUpdates==='boolean')store.autoCheckUpdates=patch.autoCheckUpdates;if(patch)saveStore();return{defaultWebMuted:store.defaultWebMuted===true,autoCheckUpdates:store.autoCheckUpdates!==false}});
  ipcMain.handle('app:updates',async()=>{try{const res=await fetch('https://api.github.com/repos/Invariant-325/course-study-utility/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'CourseStudyUtility'},signal:AbortSignal.timeout(12000)});if(!res.ok)return{ok:false,error:res.status===403?'请求受限，稍后重试':'更新服务返回 '+res.status};const d=await res.json();if(d.prerelease||d.draft)return{ok:false,error:'未找到正式版本'};const clean=v=>String(v).replace(/^v/,'').split('-')[0].split('.').map(Number);const a=clean(d.tag_name),b=clean(app.getVersion());let cmp=0;for(let i=0;i<3;i++){if(a[i]!==b[i]){cmp=a[i]>b[i]?1:-1;break}}if(!a.every(Number.isFinite))return{ok:false,error:'版本信息无效'};return{ok:true,current:app.getVersion(),latest:d.tag_name,available:cmp>0||(cmp===0&&app.getVersion().includes('-')),url:d.html_url}}catch{return{ok:false,error:'无法连接 GitHub，检查网络后重试'}}});
  const progressNamespace=async()=>{const cookies=await browser?.view?.webContents.session.cookies.get({name:'_uid'});const id=cookies?.[0]?.value;return id?require('node:crypto').createHash('sha256').update(id).digest('hex'):null};
  ipcMain.handle('courses:list', async () => {const result=coursePortal?await coursePortal.list():{ok:true,courses:[],state:{phase:'loading'}};const key=await progressNamespace();const cache=key?store.courseProgressByAccount?.[key]||{}:{};result.courses=result.courses.map(c=>({...c,progress:cache[c.id]||null}));return result;});
  ipcMain.handle('courses:refresh', async() => {if(manualQuiz?.status().busy)await manualQuiz.cancel();return coursePortal?coursePortal.refresh():{ok:false};});
  ipcMain.handle('courses:open', async(_e,id) => {if(manualQuiz?.status().busy)await manualQuiz.cancel();return coursePortal?coursePortal.open(id):{ok:false};});
  ipcMain.handle('course:openChapter', async(_e,chapter) => {if(manualQuiz?.status().busy)await manualQuiz.cancel();return coursePortal?coursePortal.openChapter(chapter):{ok:false};});
  ipcMain.on('course:domChanged',event=>{if(event.sender===browser?.view?.webContents&&isPlatformUrl(event.senderFrame?.url))notifyCourseChanged();});
  ipcMain.handle('course:refreshProgress',()=>coursePortal?coursePortal.refreshProgress():{ok:false});

  ipcMain.handle('courses:status', () => coursePortal ? coursePortal.status() : {phase:'loading'});
  ipcMain.handle('courses:start', () => coursePortal ? coursePortal.start() : {ok:false});
  ipcMain.handle('courses:cancel', () => {coursePortal?.cancelStart();return {ok:true};});
  ipcMain.handle('window:control', (_event, action) => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'NO_WINDOW' };
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'hide') win.close();
    else if (action === 'quit') { isQuitting = true; app.quit(); }
    else return { ok: false, error: 'INVALID_ACTION' };
    return { ok: true };
  });
  ipcMain.on('kv:get', (event, key, fallback) => {
    event.returnValue =
      Object.prototype.hasOwnProperty.call(store, key) && store[key] !== null ? store[key] : fallback;
  });
  ipcMain.on('kv:set', (event, key, value) => {
    if (value === null || value === undefined) delete store[key];
    else store[key] = value;
    saveStore();
  });

  ipcMain.handle('net:xhr', async (event, options) => {
    try {
      const res = await fetch(String(options.url), {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.data,
        signal: AbortSignal.timeout(Number(options.timeout) || 120000),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  });

  ipcMain.handle('vision:ask', async (event, payload) => {
    try {
      const r = await askVision(payload);
      bootLog('[vision] ok='+r.ok+' status='+(r.status||'')+' error='+(r.error||(r.errors||[]).join(','))+' '+(r.elapsedMs||0)+'ms');
      // 记录一次模型调用（无论成功失败，都算一次请求）
      try {
        bumpStats({
          visionCalls: 1,
          visionOk: r.ok ? 1 : 0,
          visionFail: r.ok ? 0 : 1,
          promptTokens: (r.usage && r.usage.promptTokens) || 0,
          completionTokens: (r.usage && r.usage.completionTokens) || 0,
        });
      } catch (e) {
        /* ignore */
      }
      return r;
    } catch (e) {
      try {
        bumpStats({ visionCalls: 1, visionFail: 1 });
      } catch (err) {
        /* ignore */
      }
      return { ok: false, status: 'unreadable', error: String(e && e.message) };
    }
  });

  // ---------------- 统计（按日聚合，本地文件）----------------
  // 只记录客户端观察到的事实：请求次数、token、播放秒数。
  // 不推断成绩、不把"本地认为完成"写成"平台已确认"。
  const STATS_FILE = () => path.join(app.getPath('userData'), 'stats.json');

  function todayKey() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function emptyDay() {
    return {
      visionCalls: 0,
      visionOk: 0,
      visionFail: 0,
      promptTokens: 0,
      completionTokens: 0,
      playSeconds: 0,
      tasksConfirmed: 0,
    };
  }

  function readStats() {
    try {
      const f = STATS_FILE();
      if (!fs.existsSync(f)) return { days: {} };
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      return s && typeof s === 'object' && s.days ? s : { days: {} };
    } catch (e) {
      return { days: {} };
    }
  }

  function writeStats(s) {
    try {
      const f = STATS_FILE();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // delta: { visionCalls, visionOk, visionFail, promptTokens, completionTokens, playSeconds, tasksConfirmed }
  function bumpStats(delta) {
    const s = readStats();
    const key = todayKey();
    const day = Object.assign(emptyDay(), s.days[key] || {});
    for (const k of Object.keys(delta || {})) {
      if (typeof delta[k] === 'number' && k in day) day[k] += delta[k];
    }
    s.days[key] = day;
    writeStats(s);
    return day;
  }

  ipcMain.handle('stats:get', async () => {
    const s = readStats();
    const keys = Object.keys(s.days).sort().reverse().slice(0, 30);
    const recent = {};
    for (const k of keys) recent[k] = s.days[k];
    return { ok: true, today: s.days[todayKey()] || emptyDay(), recent };
  });

  ipcMain.handle('stats:record', async (_e, delta) => ({ ok: true, day: bumpStats(delta || {}) }));

  // 系统通知（异常需要人工时提醒）
  ipcMain.handle('app:notify', async (_e, payload) => {
    try {
      if (!Notification.isSupported()) return { ok: false, error: 'NOT_SUPPORTED' };
      const title = String((payload && payload.title) || '课程伴学工具');
      const body = String((payload && payload.body) || '').slice(0, 200);
      new Notification({ title, body }).show();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('vision:status', async () => {
    const key = resolveApiKey();
    return {
      hasKey: !!key,
      keySource: keySource(),
      keyMasked: maskKey(key),
      endpoint: MODEL_ENDPOINT,
      model: DEFAULT_MODEL,
      // 兼容旧字段
      dshFound: !!findDshCli(),
      home: dshHomeDir(),
    };
  });

  // ---- 模型设置（面向普通用户：填 Key 即用，不需要 DSH、不需要配置文件）----
  ipcMain.handle('model:setKey', async (_e, key) => storeKey(key));
  ipcMain.handle('model:clearKey', async () => clearStoredKey());

  ipcMain.handle('model:test', async () => {
    const key = resolveApiKey();
    if (!key) return { ok: false, error: 'MISSING_CREDENTIAL' };
    const started = Date.now();
    try {
      const res = await fetch(MODEL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: '只回复两个字：可用' }],
          max_tokens: 16,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      const elapsedMs = Date.now() - started;
      if (!res.ok) {
        const safe = String(text || '').replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***').slice(0, 200);
        return { ok: false, error: 'HTTP_' + res.status, detail: safe, elapsedMs };
      }
      let content = '';
      try {
        const j = JSON.parse(text);
        content = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
      } catch (e) {
        /* ignore */
      }
      return { ok: true, content: content.slice(0, 40), elapsedMs, model: DEFAULT_MODEL };
    } catch (e) {
      return { ok: false, error: 'NETWORK_ERROR', detail: String((e && e.message) || e).slice(0, 200), elapsedMs: Date.now() - started };
    }
  });

  // 版本与安装位置（用于 UI 显示与升级排查）
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    name: app.getName(),
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    exePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
  }));

  ipcMain.on('menu:register', (event, label) => bootLog('[menu] ' + label));

  ipcMain.handle('web:goto', (_event, url) => browser ? browser.goto(String(url)) : { ok: false });
  ipcMain.handle('web:reload', () => browser ? browser.reload() : { ok: false });
  ipcMain.handle('web:back', () => browser ? browser.back() : { ok: false });
  ipcMain.handle('web:eval', async (event, code) => {
    const view = browser && browser.view;
    if (!view) return { ok: false, error: 'no-view' };
    try {
      const frames=[];collectFrames(view.webContents.mainFrame,frames);
      let target=view.webContents.mainFrame;
      for(const frame of frames){if(!isPlatformUrl(frame.url))continue;
        const ready=await frame.executeJavaScript('!!window.__cxNaturalWatchApp?.runner && location.pathname.toLowerCase().endsWith("/mycourse/studentstudy")').catch(()=>false);
        if(ready){target=frame;break;}
      }
      return { ok: true, result: await target.executeJavaScript(String(code), true) };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
  ipcMain.handle('web:evalQuiz', async (event, code) => {
    const view = browser && browser.view;
    if (!view) return { ok: false, error: 'no-view' };
    const frames = [];
    try { collectFrames(view.webContents.mainFrame, frames); } catch (e) { return { ok: false, error: 'frame-enum' }; }
    // Locate the actual adapter/DOM, including top-level and nested quiz pages.
    // URL names alone miss new routes and can select an empty wrapper iframe.
    let target;
    for (const frame of frames) {
      try {
        if (!isPlatformUrl(frame.url)) continue;
        const ready = await frame.executeJavaScript('!!(window.__cxChapterQuiz && window.__cxChapterQuiz.parse().count)', true);
        if (ready) { target = frame; break; }
      } catch { /* detached or not ready */ }
    }
    if (!target) return { ok: false, error: 'no-quiz-frame' };
    try {
      return { ok: true, result: await target.executeJavaScript(String(code), true) };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
  ipcMain.handle('web:info', () => browser ? browser.info() : { url: '', title: '' });
  ipcMain.handle('web:home', () => browser ? browser.home() : { ok: false });

  // 网页视图显示/隐藏：默认隐藏，只在本机 UI 里按需切换
  ipcMain.handle('web:toggle', async (_e, force) => {
    if (!browser) return { ok: false, visible: false };
    const next = typeof force === 'boolean' ? force : !browser.isVisible();
    browser.setVisible(next);
    return { ok: true, visible: next };
  });

  ipcMain.handle('web:visible', async () => ({ ok: true, visible: browser ? browser.isVisible() : false }));

  // ---------------- 课程总览（仪表盘）----------------
  // 只读：章节列表、待完成数、最近学习记录。不改页面，不推断完成。
  ipcMain.handle('course:overview', async () => {
    const view = browser && browser.view;
    if (!view || !view.webContents || view.webContents.isDestroyed()) return { ok: false, reason: 'no-view' };
    const code = `(function(){
      var a = window.__cxNaturalWatchApp;
      if (!a || !a.tree) return { ok: false, reason: 'not-mounted' };
      try {
        var cat = a.tree.catalogEntries();
        var prog = null;
        try { prog = a.tree.catalogProgress(); } catch (e) { prog = null; }
        var sum = null;
        try { sum = a.tree.readCatalogSummary(); } catch (e) { sum = null; }
        var cursor = null;
        try { cursor = a.config && a.config.readCursor ? a.config.readCursor() : null; } catch (e) { cursor = null; }
        var cleanChapter = ${cleanChapterTitle.toString()};
        var items = (cat.items || []).map(function (el) {
          var label=el.querySelector('.chapter-title,.catalog_name,.catalog_title,.posCatalog_name,span[title]');
          var title=cleanChapter(label?.textContent||label?.getAttribute('title')||el.textContent||'');
          var progress=a.tree.readCatalogState?.(el)||{pending:a.tree.readCatalogPending(el)};
          return {title,...progress};
        });
        return { ok: true, items: items, progress: prog, summary: sum, cursor: cursor,tabs:a.tree.readTaskTabs?.(), jobs:a.tree.enumerate().map(j=>({type:j.type,state:j.state})) };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    })()`;
    try {
      const frames=[];collectFrames(view.webContents.mainFrame,frames);
      let data=null;
      for(const frame of frames){if(!isPlatformUrl(frame.url))continue;
        const value=await frame.executeJavaScript(code,true).catch(()=>null);
        if(value?.ok&&value.items?.length){data=value;break;}
      }
      const landing=await coursePortal.overview();
      const known=value=>(value?.items||[]).filter(i=>i.pending!==null&&i.pending!==undefined).length;
      if(!data||known(landing)>known(data))data=landing;
      const id=coursePortal?.status().selected,key=await progressNamespace();
      if(data.ok&&id&&key){
        store.courseProgressByAccount ||= {};const cache=store.courseProgressByAccount[key] ||= {};const saved=cache[id] ||= {chapters:{}};
        if(data.summary&&Number(data.summary.total)>0&&data.summary.done>=0&&data.summary.done<=data.summary.total)saved.summary={done:Number(data.summary.done),total:Number(data.summary.total)};
        if(!data.summary&&data.items?.length&&data.items.every(i=>i.pending!==null&&i.pending!==undefined))saved.summary={done:data.items.filter(i=>i.pending===0).length,total:data.items.length,unit:'chapters'};
        const clean=cleanChapterTitle;
        const active=data.progress?.items?.find(i=>i.active);const jobs=data.jobs||[];
        const finished=type=>{const list=jobs.filter(j=>j.type===type);return list.length&&list.every(j=>j.state==='finished')?true:list.some(j=>j.state==='unfinished')?false:null};
        for(const item of data.items||[]){const title=clean(item.title);const old=saved.chapters[title]||{};
          const known=item.pending!==null&&item.pending!==undefined;
          if(known&&old.pending!==item.pending){delete old.videoDone;delete old.quizDone;delete old.complete;}
          if(known)Object.assign(old,{pending:item.pending,complete:item.pending===0});
          for(const field of ['videoDone','quizDone','completed','total'])if(item[field]!==null&&item[field]!==undefined)old[field]=item[field];
          if(active&&clean(active.title||active.text)===title&&item.pending!==0){const videoDone=finished('video'),quizDone=finished('work');if(old.videoDone==null&&videoDone!==null)old.videoDone=videoDone;if(old.quizDone==null&&quizDone!==null)old.quizDone=quizDone;Object.assign(old,{hasVideo:jobs.some(j=>j.type==='video')||data.tabs?.video===true,hasQuiz:jobs.some(j=>j.type==='work')||data.tabs?.quiz===true});}
          saved.chapters[title]=old;Object.assign(item,old);
        }
        saved.updatedAt=Date.now();saveStore();
      }
      return {ok:true,data};
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });

  // ---------------- 待办任务队列（持久化）----------------
  // 存 userData/tasks.json；状态四态：todo/doing/done/manual
  const TASKS_FILE = () => path.join(app.getPath('userData'), 'tasks.json');

  function readTasks() {
    try {
      const f = TASKS_FILE();
      if (!fs.existsSync(f)) return [];
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function writeTasks(list) {
    try {
      const f = TASKS_FILE();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(Array.isArray(list) ? list : [], null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  ipcMain.handle('tasks:list', async () => ({ ok: true, tasks: readTasks() }));

  ipcMain.handle('tasks:save', async (_e, list) => writeTasks(list));

  ipcMain.handle('tasks:add', async (_e, task) => {
    const list = readTasks();
    const now = Date.now();
    const item = Object.assign(
      {
        id: 't_' + now + '_' + Math.random().toString(36).slice(2, 7),
        courseId: '',
        courseName: '',
        chapterTitle: '',
        type: 'all',
        priority: 1,
        status: 'todo',
        note: '',
      },
      task || {},
      { createdAt: now, updatedAt: now }
    );
    list.push(item);
    const r = writeTasks(list);
    return r.ok ? { ok: true, tasks: list, added: item } : r;
  });

  ipcMain.handle('tasks:update', async (_e, id, patch) => {
    const list = readTasks();
    const i = list.findIndex((t) => t && t.id === id);
    if (i < 0) return { ok: false, error: 'NOT_FOUND' };
    list[i] = Object.assign({}, list[i], patch || {}, { updatedAt: Date.now() });
    const r = writeTasks(list);
    return r.ok ? { ok: true, tasks: list, updated: list[i] } : r;
  });

  ipcMain.handle('tasks:remove', async (_e, id) => {
    const list = readTasks().filter((t) => !t || t.id !== id);
    const r = writeTasks(list);
    return r.ok ? { ok: true, tasks: list } : r;
  });

  // ---------------- 夜间静默模式 ----------------
  // 需求：确认后 30 秒关闭显示屏 + 静音，进入无人监管刷课。
  // 关屏用 WM_SYSCOMMAND/SC_MONITORPOWER；静音只作用于网页音频，不改系统音量，
  // 避免影响用户其他程序。任何一步失败都如实回报，不假装成功。
  let nightTimer = null;
  let nightState = { pending: false, active: false, executeAt: 0, error: '' };

  function setAppMuted(muted) {
    try {
      const view = browser && browser.view;
      if (!view || !view.webContents || view.webContents.isDestroyed()) return { ok: false, error: 'no-view' };
      browser.setMuted(!!muted);
      return { ok: true, muted: !!muted };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  }

  function turnOffMonitor() {
    return new Promise((resolve) => {
      const script = [
        'Add-Type -Namespace CxNight -Name Display -MemberDefinition @\'',
        '[DllImport("user32.dll")]',
        'public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);',
        '\'@',
        '$r = [CxNight.Display]::SendMessage([IntPtr]0xffff, 0x0112, [IntPtr]0xF170, [IntPtr]2)',
        'Write-Output ("SENT:" + $r)',
      ].join('\n');
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
        child.on('exit', (code) => {
          if (code === 0) resolve({ ok: true, out: out.trim() });
          else resolve({ ok: false, error: 'powershell exit ' + code + ' ' + err.slice(0, 200) });
        });
        setTimeout(() => { try { child.kill(); } catch (e) {} resolve({ ok: false, error: 'timeout' }); }, 8000);
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message) });
      }
    });
  }

  ipcMain.handle('night:schedule', async (_e, delayMs) => {
    sleepGuard.set('night',true);
    if (nightTimer) { clearTimeout(nightTimer); nightTimer = null; }
    const wait = Math.max(0, Number(delayMs) || 30000);
    nightState = { pending: true, active: false, executeAt: Date.now() + wait, error: '' };
    bootLog('[night] scheduled in ' + Math.round(wait / 1000) + 's');
    nightTimer = setTimeout(async () => {
      nightTimer = null;
      const mute = setAppMuted(true);
      const monitor = await turnOffMonitor();
      nightState = {
        pending: false,
        active: true,
        executeAt: nightState.executeAt,
        error: [mute.ok ? '' : 'mute:' + mute.error, monitor.ok ? '' : 'monitor:' + monitor.error].filter(Boolean).join(';'),
      };
      bootLog('[night] executed mute=' + mute.ok + ' monitor=' + monitor.ok + ' err=' + nightState.error);
      if (win && !win.isDestroyed()) win.webContents.send('night:changed', nightState);
    }, wait);
    return { ok: true, pending: true, executeAt: nightState.executeAt };
  });

  ipcMain.handle('night:cancel', async () => {
    sleepGuard.set('night',false);
    if (nightTimer) { clearTimeout(nightTimer); nightTimer = null; }
    setAppMuted(store.defaultWebMuted===true);
    nightState = { pending: false, active: false, executeAt: 0, error: '' };
    bootLog('[night] cancelled');
    if (win && !win.isDestroyed()) win.webContents.send('night:changed', nightState);
    return { ok: true };
  });

  ipcMain.handle('night:status', async () => ({...nightState,preventingSleep:sleepGuard.active()}));

  ipcMain.handle('app:setMuted', async (_e, muted) => setAppMuted(muted));
}

// ---------------------------------------------------------------- 启动
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // ---------------------------------------------------------------- 托盘
// 收起主窗口后仍能在托盘里看到状态、暂停、结束。
let tray = null;
let trayTimer = null;

async function callRunner(method) {
  const view = browser && browser.view;
  if (!view || !view.webContents || view.webContents.isDestroyed()) return false;
  try {
    await view.webContents.executeJavaScript(
      '(function(){var a=window.__cxNaturalWatchApp;if(a&&a.runner){try{a.runner.' + method + '();}catch(e){}}})()',
      true
    );
    return true;
  } catch (e) {
    return false;
  }
}

async function readRunnerLine() {
  const view = browser && browser.view;
  if (!view || !view.webContents || view.webContents.isDestroyed()) return '';
  try {
    return await view.webContents.executeJavaScript(
      '(function(){' +
        'var a=window.__cxNaturalWatchApp;' +
        'if(!a||!a.runner)return "";' +
        'try{var s=a.runner.snapshot();' +
        'var label=s.stateLabel||s.state||"";' +
        'var job=s.jobTitle?" · "+s.jobTitle:"";' +
        'var v=s.video||{};' +
        'var pct=v.duration>0?Math.round(((v.currentTime||0)/v.duration)*100)+"%":"";' +
        'return label+job+(pct?" · "+pct:"");}catch(e){return "";}' +
      '})()',
      true
    );
  } catch (e) {
    return '';
  }
}

function rebuildTray(statusLine) {
  if (!tray) return;
  tray.setToolTip('课程伴学工具' + (statusLine ? '\n' + statusLine : ''));
  const menu = Menu.buildFromTemplate([
    { label: statusLine || '尚未进入课程', enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '暂停刷课', click: () => callRunner('pause') },
    { label: '继续刷课', click: () => callRunner('resume') },
    { label: '结束任务', click: () => callRunner('stop') },
    { type: 'separator' },
    { label: '退出程序', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  try {
    let img = null;
    try {
      const iconPath = path.join(__dirname, 'build', 'icon.ico');
      if (fs.existsSync(iconPath)) img = nativeImage.createFromPath(iconPath);
    } catch (e) {
      img = null;
    }
    tray = new Tray(img && !img.isEmpty() ? img : nativeImage.createEmpty());
    rebuildTray('');
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
    let lastLine = '';
    trayTimer = setInterval(async () => {
      const line = await readRunnerLine();
      if (line && line !== lastLine) {
        lastLine = line;
        rebuildTray(line);
      }
    }, 3000);
    bootLog('tray-created');
  } catch (e) {
    bootLog('tray-failed: ' + ((e && e.message) || e));
  }
}

app.whenReady().then(async () => {
    bootLog('ready');
    loadStore();
    const userscript = loadUserscript();
    if (userscript.length < 1000) throw new Error('Missing bundled userscript. Reinstall the complete application.');
    injectCode = buildInjectCode(userscript);
    registerIpc();
    Menu.setApplicationMenu(null);
    createTray();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { closingWindow = false; createWindow().catch(fatalStartup); }
    });
  }).catch(fatalStartup);

  app.on('window-all-closed', () => {
    // 有托盘时收进托盘继续运行；真正退出走托盘菜单
    if (isQuitting && process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (trayTimer) {
      clearInterval(trayTimer);
      trayTimer = null;
    }
  });
}

app.on('before-quit', () => { bootLog('quit'); flushStore(); });
