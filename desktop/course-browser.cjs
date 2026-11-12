const { PORTAL_URL, isPlatformUrl, isAllowedNavigationUrl, isLandingUrl, clickCourseMenu } = require('./browser-policy.cjs');

function createCourseBrowser({ win, WebContentsView, ses, preload, inject, log, defaultMuted = false }) {
  const pages = [];
  let active, closing = false;
  const states = new WeakMap();
  const blocked = () => {
    if(active)states.get(active).error='已阻止不受信任的网页：仅允许 HTTPS 平台页面';
    log('navigation-blocked');
  };
  // Request-level guard also covers loadURL(), HTTP redirects and iframe loads.
  // It is installed once on this dedicated platform session, not on the UI or
  // the user's browser. Images/video CDN requests are not treated as documents.
  ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const documentRequest=details.resourceType==='mainFrame'||details.resourceType==='subFrame';
    const cancel=documentRequest&&details.url!=='about:blank'&&details.url!=='about:srcdoc'&&!isAllowedNavigationUrl(details.url);
    if(cancel)blocked();callback({cancel});
  });
  // 默认不展示网页内容：全程在后台运行，需要登录/扫码时才临时显示
  let viewVisible = false;
  const SIDEBAR_W = 280;
  function layout() {
    if (!active || win.isDestroyed()) return;
    const b = win.getContentBounds();
    // 显示时占右侧内容区，不盖住自绘侧栏
    active.setBounds({
      x: SIDEBAR_W,
      y: 48,
      width: Math.max(200, b.width - SIDEBAR_W),
      height: Math.max(200, b.height - 48),
    });
    active.setVisible(viewVisible);
  }
  function setViewVisible(v) {
    viewVisible = !!v;
    if (active) {
      active.setVisible(viewVisible);
      if (viewVisible) layout();
    }
    return viewVisible;
  }
  function isViewVisible() {
    return viewVisible;
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
    if (!isAllowedNavigationUrl(url)) {blocked();return { ok: false, error: '仅允许打开 HTTPS 平台页面' };}
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
      session: ses, preload, contextIsolation: true, nodeIntegration: false,webSecurity:true,allowRunningInsecureContent:false,
      nodeIntegrationInSubFrames: false, sandbox: true, backgroundThrottling: false } });
    page.webContents.setAudioMuted(defaultMuted);
    page.setBackgroundColor('#ffffff');
    const wc = page.webContents;
    const state = { error: '', lastGood: PORTAL_URL, routing: false, recovered: false,
      epoch: 0, menuOpened: false, routeAttempts: 0, routeTimer: null };
    states.set(page, state);
    pages.push(page);
    activate(page);
    wc.setWindowOpenHandler(({ url }) => {
      if (!isAllowedNavigationUrl(wc.getURL()) || (url !== 'about:blank' && !isAllowedNavigationUrl(url))) {blocked();return { action: 'deny' };}
      if (pages.length >= 12) return { action: 'deny' };
      // Preserve opener, POST, and delayed about:blank navigation. Chromium owns
      // navigation; manually loadURL(url) here loses all three.
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: {
        session: ses, preload, contextIsolation: true, sandbox: true,webSecurity:true,allowRunningInsecureContent:false,
        nodeIntegration: false, nodeIntegrationInSubFrames: false,
      } }, createWindow: opts => create(opts).webContents };
    });
    wc.on('will-navigate', (event, url) => {
      if (!isAllowedNavigationUrl(url)) {event.preventDefault();blocked();}
    });
    wc.on('will-frame-navigate',event=>{
      if(event.url!=='about:blank'&&event.url!=='about:srcdoc'&&!isAllowedNavigationUrl(event.url)){event.preventDefault();blocked();}
    });
    wc.on('will-redirect',(event,url)=>{
      if(!isAllowedNavigationUrl(event.url||url)){event.preventDefault();blocked();}
    });
    wc.on('certificate-error',(event,_url,_error,_certificate,callback)=>{
      event.preventDefault();states.get(page).error='网页证书验证失败，已拒绝连接';log('certificate-rejected');callback(false);
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
    setMuted(value) {defaultMuted=!!value;for(const p of pages)if(!p.webContents.isDestroyed())p.webContents.setAudioMuted(defaultMuted);},
    setVisible: setViewVisible,
    isVisible: isViewVisible,
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
        if (isAllowedNavigationUrl(entries[i].url)) { history.goToIndex(i); layout(); return { ok: true }; }
      }
      if (pages.length > 1) { dispose(active); return { ok: true }; }
      return load(active, PORTAL_URL);
    },
    info() { const wc = active.webContents; return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), error: states.get(active).error, canGoBack: pages.length > 1 || wc.navigationHistory.canGoBack() }; },
    close() { closing = true; for (const page of [...pages].reverse()) dispose(page); },
  };
}
module.exports = { createCourseBrowser };
