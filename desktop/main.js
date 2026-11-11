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
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, dialog, safeStorage } = electron;
const { createCourseBrowser } = require("./course-browser.cjs");
const { retainLogin } = require("./login-session.cjs");
const { isPlatformUrl } = require("./browser-policy.cjs");
const { installFrameBridge } = require("./frame-bridge.cjs");
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

let win = null;
let browser = null;
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

function injectAllFrames(wc) {
  if (!wc || wc.isDestroyed() || !injectCode || !isPlatformUrl(wc.getURL())) return;
  const frames = [];
  try { collectFrames(wc.mainFrame, frames); } catch { return; }
  const topOrigin = new URL(wc.getURL()).origin;
  const frameSetup = '(' + installFrameBridge.toString() + ')(' + JSON.stringify(topOrigin) + ',' + JSON.stringify(store) + ');';
  for (const frame of frames) {
    try {
      if (!isPlatformUrl(frame.url)) continue;
      frame.executeJavaScript(frameSetup + injectCode, true).catch(() => bootLog('frame-injection-retry-needed'));
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
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: '课程伴学工具', backgroundColor: '#0f1218', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html')).catch(fatalStartup);
  win.webContents.on('did-finish-load', () => bootLog('control-panel-loaded'));
  win.webContents.on('render-process-gone', (_event, details) => bootLog('panel-process-gone: ' + details.reason));
  browser = createCourseBrowser({ win, WebContentsView, ses: persist,
    preload: path.join(__dirname, 'preload.js'), inject: injectAllFrames, log: bootLog });
  // Use the portal's own course-menu handler after normal platform login.
  browser.home();
  win.on('close', event => {
    if (closingWindow) return;
    event.preventDefault();
    closingWindow = true;
    (async () => {
      try { flushStore(); await loginSession.flush(); }
      catch { bootLog('close-save-failed'); }
      browser.close();
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
  '{"questionId":"q_001","type":"single","answers":["B"],"status":"ok"}',
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
              { type: 'text', text: '题目 ID：' + questionId + '。请阅读图片中的题目并作答。' },
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
  if (String(parsed.questionId || '') !== questionId) errors.push('QUESTION_ID_MISMATCH');
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
  };
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
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
      bootLog('[vision] ' + (payload && payload.questionId) + ' ok=' + r.ok + ' ' + (r.elapsedMs || 0) + 'ms');
      return r;
    } catch (e) {
      return { ok: false, status: 'unreadable', error: String(e && e.message) };
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
      return { ok: true, result: await view.webContents.executeJavaScript(String(code), true) };
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
        var items = (cat.items || []).map(function (el) {
          var txt = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
          var m = txt.match(/(\\d+)\\s*个待完成/);
          return { title: txt, pending: m ? Number(m[1]) : null };
        });
        return { ok: true, items: items, progress: prog, summary: sum, cursor: cursor };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    })()`;
    try {
      return { ok: true, data: await view.webContents.executeJavaScript(code, true) };
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
      view.webContents.setAudioMuted(!!muted);
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
    if (nightTimer) { clearTimeout(nightTimer); nightTimer = null; }
    setAppMuted(false);
    nightState = { pending: false, active: false, executeAt: 0, error: '' };
    bootLog('[night] cancelled');
    if (win && !win.isDestroyed()) win.webContents.send('night:changed', nightState);
    return { ok: true };
  });

  ipcMain.handle('night:status', async () => nightState);

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

  app.whenReady().then(async () => {
    bootLog('ready');
    loadStore();
    const userscript = loadUserscript();
    if (userscript.length < 1000) throw new Error('Missing bundled userscript. Reinstall the complete application.');
    injectCode = buildInjectCode(userscript);
    registerIpc();
    Menu.setApplicationMenu(null);
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { closingWindow = false; createWindow().catch(fatalStartup); }
    });
  }).catch(fatalStartup);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

app.on('before-quit', () => { bootLog('quit'); flushStore(); });
