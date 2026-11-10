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
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, dialog } = electron;
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
  dialog.showErrorBox('学习通助手启动失败', '程序启动失败，详情已记录到：\n' + BOOT_LOG + '\n\n' + detail);
  app.exit(1);
}
process.on('uncaughtException', fatalStartup);
process.on('unhandledRejection', (e) => {
  bootLog('unhandled: ' + String(e && (e.stack || e.message) || e));
  console.error(e);
});
bootLog('boot; version=' + app.getVersion() + '; electron=' + process.versions.electron);

const TOP_BAR = 56;
const SIDE_PANEL = 340;

let win = null;
let view = null;
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

function injectAllFrames() {
  if (!view || view.webContents.isDestroyed() || !injectCode) return;
  const frames = [];
  try {
    collectFrames(view.webContents.mainFrame, frames);
  } catch (e) {
    return;
  }
  for (const frame of frames) {
    let url = '';
    try {
      url = String(frame.url || '');
    } catch (e) {
      continue;
    }
    if (!/chaoxing\.com|xuexitong\.com/i.test(url)) continue;
    frame.executeJavaScript(injectCode, true).catch(() => {});
  }
}

// ---------------------------------------------------------------- 布局
function layout() {
  if (!win || !view) return;
  const b = win.getContentBounds();
  view.setBounds({
    x: 0,
    y: TOP_BAR,
    width: Math.max(200, b.width - SIDE_PANEL),
    height: Math.max(200, b.height - TOP_BAR),
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: '学习通助手',
    backgroundColor: '#0f1218',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html')).catch(fatalStartup);
  win.webContents.on('did-finish-load', () => bootLog('control-panel-loaded'));
  win.webContents.on('render-process-gone', (_event, details) => bootLog('panel-process-gone: ' + details.reason));

  const persist = session.fromPartition('persist:chaoxing');
  view = new WebContentsView({
    webPreferences: {
      session: persist,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // 切到后台不节流，保证视频与轮询继续
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  layout();

  const wc = view.webContents;
  wc.on('render-process-gone', (_event, details) => bootLog('web-process-gone: ' + details.reason));
  wc.on('did-finish-load', () => bootLog('web-page-loaded'));
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) bootLog('web-load-failed: ' + code + ' ' + description);
  });

  wc.setWindowOpenHandler(({ url }) => {
    try {
      view.webContents.loadURL(url);
    } catch (e) {
      /* ignore */
    }
    return { action: 'deny' };
  });

  wc.on('dom-ready', () => setTimeout(injectAllFrames, 300));
  wc.on('did-frame-finish-load', () => setTimeout(injectAllFrames, 200));
  wc.on('did-navigate', () => setTimeout(injectAllFrames, 600));

  wc.on('page-title-updated', (event, title) => {
    if (win && !win.isDestroyed()) win.setTitle(title + ' — 学习通助手');
  });

  view.webContents.loadURL('https://mooc1.chaoxing.com/').catch((e) => bootLog('homepage-load-failed: ' + e.code));

  win.on('resize', layout);
  win.on('closed', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    win = null;
    view = null;
  });
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

function resolveApiKey() {
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
      const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
      if (m && m[1]) return m[1];
    } catch (e) {
      /* ignore */
    }
  }
  return '';
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
  '8. 不调用任何执行工具，不操作网页，不修改任何文件。',
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
      child = spawn(
        'cmd.exe',
        ['/c', cli, '--profile', 'headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'],
        {
          cwd: app.getPath('userData'),
          env: Object.assign({}, process.env, { DSH_HOME: dshHomeDir() }),
          stdio: [inFd, outFd, errFd],
          windowsHide: true,
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
  const questionId = String((payload && payload.questionId) || '').slice(0, 80);
  const imageBase64 = String((payload && payload.imageBase64) || '');
  const allowedLetters = Array.isArray(payload && payload.allowedLetters)
    ? payload.allowedLetters.map((x) => String(x).toUpperCase()).slice(0, 8)
    : [];

  if (!questionId || !/^[\w\-:.]{1,80}$/.test(questionId)) {
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

  const tmp = path.join(app.getPath('temp'), 'cx-vision');
  fs.mkdirSync(tmp, { recursive: true });
  const imgPath = path.join(tmp, 'req-' + questionId.replace(/[^\w\-]/g, '_') + '-' + Date.now() + '.png');
  fs.writeFileSync(imgPath, buf);

  const task = [SYSTEM_TASK, '', '题目 ID：' + questionId, '题目截图（绝对路径）：' + imgPath, '请读取该图片并作答。'].join('\n');
  const started = Date.now();
  const result = await runHeadless(task, 120000);
  const elapsedMs = Date.now() - started;
  try { fs.rmSync(imgPath, { force: true }); } catch (e) {}

  if (result.code !== 0) {
    const tail = String(result.stderr || '').replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***').slice(-300);
    return { ok: false, status: 'unreadable', error: 'SESSION_EXIT_' + result.code, stderr: tail, elapsedMs };
  }

  let parsed;
  try {
    parsed = extractJson(result.stdout);
  } catch (e) {
    return { ok: false, status: 'unreadable', error: 'PARSE_FAILED', elapsedMs };
  }

  const errors = [];
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
  if ((type === 'single' || type === 'true_false') && answers.length > 1) answers = answers.slice(0, 1);

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

  ipcMain.handle('vision:status', async () => ({
    dshFound: !!findDshCli(),
    dshPath: findDshCli(),
    hasKey: !!resolveApiKey(),
    home: dshHomeDir(),
  }));

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

  ipcMain.handle('web:goto', async (event, url) => {
    if (!view) return { ok: false };
    try { view.webContents.loadURL(url); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message) }; }
  });
  ipcMain.handle('web:reload', async () => {
    if (view) view.webContents.reload();
    return { ok: true };
  });
  ipcMain.handle('web:back', async () => {
    if (!view) return { ok: false };
    try {
      if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
    } catch (e) {
      /* ignore */
    }
    return { ok: true };
  });
  ipcMain.handle('web:eval', async (event, code) => {
    if (!view) return { ok: false, error: 'no-view' };
    try {
      return { ok: true, result: await view.webContents.executeJavaScript(String(code), true) };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
  ipcMain.handle('web:evalQuiz', async (event, code) => {
    if (!view) return { ok: false, error: 'no-view' };
    const frames = [];
    try { collectFrames(view.webContents.mainFrame, frames); } catch (e) { return { ok: false, error: 'frame-enum' }; }
    const target = frames.find((f) => {
      try { return /doHomeWorkNew|work\/doWork/i.test(String(f.url || '')); } catch (e) { return false; }
    });
    if (!target) return { ok: false, error: 'no-quiz-frame' };
    try {
      return { ok: true, result: await target.executeJavaScript(String(code), true) };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
  ipcMain.handle('web:info', async () => {
    if (!view) return { url: '', title: '' };
    try {
      return { url: view.webContents.getURL(), title: view.webContents.getTitle() };
    } catch (e) {
      return { url: '', title: '' };
    }
  });

  // 打开学习通首页 / 课程列表
  ipcMain.handle('web:home', async () => {
    if (!view) return { ok: false };
    try { view.webContents.loadURL('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu'); return { ok: true }; } catch (e) { return { ok: false }; }
  });
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

  app.whenReady().then(() => {
    bootLog('ready');
    loadStore();
    const userscript = loadUserscript();
    if (userscript.length < 1000) throw new Error('Missing bundled userscript. Reinstall the complete application.');
    injectCode = buildInjectCode(userscript);
    registerIpc();
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(fatalStartup);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

app.on('before-quit', () => bootLog('quit'));
