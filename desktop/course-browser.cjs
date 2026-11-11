const { PORTAL_URL, isPlatformUrl, isLandingUrl, clickCourseMenu } = require('./browser-policy.cjs');

function createCourseBrowser({ win, WebContentsView, ses, preload, inject, log }) {
  const pages = [];
  let active, closing = false;
  const states = new WeakMap();
  function layout() {
    if (!active || win.isDestroyed()) return;
    const b = win.getContentBounds();
    active.setBounds({ x: 0, y: 56, width: Math.max(200, b.width - 340), height: Math.max(200, b.height - 56) });
    active.setVisible(true);
  }
  function activate(page) {
    if (active) { active.setVisible(false); win.contentView.removeChildView(active); }
    active = page;
    win.contentView.addChildView(page);
    layout();
    page.webContents.invalidate();
  }
  function dispose(page) {
    clearTimeout(states.get(page).routeTimer);
    const index = pages.indexOf(page);
    if (index >= 0) pages.splice(index, 1);
    if (active === page) {
      if (!win.isDestroyed()) win.contentView.removeChildView(page);
      active = null;
      if (!closing && pages.length) activate(pages[pages.length - 1]);
    }
    if (!page.webContents.isDestroyed()) page.webContents.close();
  }
  async function load(page, url) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 HTTP/HTTPS 网页' };
    const state = states.get(page);
    state.error = '';
    try { await page.webContents.loadURL(url); return { ok: true }; }
    catch (e) {
      if (e.code === 'ERR_ABORTED') return { ok: true };
      state.error = '页面加载失败：' + (e.code || 'NETWORK_ERROR') + '，可点击刷新重试';
      return { ok: false, error: state.error };
    }
  }
  async function afterLoad(page) {
    const wc = page.webContents;
    if (wc.isDestroyed()) return;
    const state = states.get(page);
    state.error = '';
    state.lastGood = wc.getURL();
    if (page === active) { layout(); wc.invalidate(); }
    inject(wc);
    await routeToCourses(page);
  }
  async function routeToCourses(page) {
    const wc = page.webContents;
    const state = states.get(page);
    if (closing || page !== active || wc.isDestroyed() || !isLandingUrl(wc.getURL()) || state.menuOpened || state.routing) return;
    const epoch = state.epoch;
    state.routing = true;
    try {
      const clicked = await wc.executeJavaScript('(' + clickCourseMenu.toString() + ')()', true);
      if (wc.isDestroyed() || state.epoch !== epoch) return;
      state.menuOpened = clicked;
      if (!clicked && ++state.routeAttempts < 12) {
        clearTimeout(state.routeTimer);
        state.routeTimer = setTimeout(() => routeToCourses(page).catch(() => log('course-menu-unavailable')), 500);
      }
    } finally { state.routing = false; }
  }
  function create(options = {}) {
    const page = new WebContentsView({ ...(options.webContents ? {webContents: options.webContents} : {}), webPreferences: { ...options.webPreferences,
      session: ses, preload, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, sandbox: true, backgroundThrottling: false } });
    page.setBackgroundColor('#ffffff');
    const wc = page.webContents;
    const state = { error: '', lastGood: PORTAL_URL, routing: false, recovered: false,
      epoch: 0, menuOpened: false, routeAttempts: 0, routeTimer: null };
    states.set(page, state);
    pages.push(page);
    activate(page);
    wc.setWindowOpenHandler(({ url }) => {
      if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) return { action: 'deny' };
      if (pages.length >= 12) return { action: 'deny' };
      // Preserve opener, POST, and delayed about:blank navigation. Chromium owns
      // navigation; manually loadURL(url) here loses all three.
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: {
        session: ses, preload, contextIsolation: true, sandbox: true,
        nodeIntegration: false, nodeIntegrationInSubFrames: false,
      } }, createWindow: opts => create(opts).webContents };
    });
    wc.on('will-navigate', (event, url) => {
      if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) event.preventDefault();
    });
    wc.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      clearTimeout(state.routeTimer);
      state.epoch++;
      state.menuOpened = false;
      state.routeAttempts = 0;
    });
    wc.on('did-finish-load', () => { log('web-page-loaded'); afterLoad(page).catch(() => log('web-ready-failed')); });
    wc.on('did-frame-finish-load', () => inject(wc));
    wc.on('did-navigate-in-page', () => inject(wc));
    wc.on('did-fail-load', (_e, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { state.error = '页面加载失败（' + code + '），请刷新重试'; log('web-load-failed: ' + code); }
    });
    wc.on('render-process-gone', (_e, details) => {
      log('web-process-gone: ' + details.reason);
      state.error = '网页进程已退出，请刷新重试';
      if (!state.recovered && page === active && isPlatformUrl(state.lastGood)) {
        state.recovered = true;
        load(page, state.lastGood);
      }
    });
    wc.on('page-title-updated', () => { if (!win.isDestroyed()) win.setTitle('课程伴学工具'); });
    wc.on('destroyed', () => { if (!closing && pages.includes(page)) dispose(page); });
    return page;
  }
  create();
  win.on('resize', layout);
  win.on('restore', () => { layout(); if (active) active.webContents.invalidate(); });
  return {
    get view() { return active; },
    goto(url) { return load(active, url); },
    async home() {
      const state = states.get(active);
      if (isLandingUrl(active.webContents.getURL())) {
        state.menuOpened = false; state.routeAttempts = 0;
        await routeToCourses(active);
        return { ok: true };
      }
      return load(active, PORTAL_URL);
    },
    reload() { if (active.webContents.isCrashed()) return load(active, states.get(active).lastGood); active.webContents.reload(); return { ok: true }; },
    back() {
      const history = active.webContents.navigationHistory;
      const entries = history.getAllEntries();
      for (let i = history.getActiveIndex() - 1; i >= 0; i--) {
        if (/^https?:\/\//i.test(entries[i].url)) { history.goToIndex(i); layout(); return { ok: true }; }
      }
      if (pages.length > 1) { dispose(active); return { ok: true }; }
      return load(active, PORTAL_URL);
    },
    info() { const wc = active.webContents; return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), error: states.get(active).error, canGoBack: pages.length > 1 || wc.navigationHistory.canGoBack() }; },
    close() { closing = true; for (const page of [...pages].reverse()) dispose(page); },
  };
}
module.exports = { createCourseBrowser };
