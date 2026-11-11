// ---------------------------------------------------------------------------
// preload.js —— 一个 preload 服务两种页面
//
//   file://  （控制面板）  → 暴露 __cxApp：窗口控制、网页控制、视觉调用、环境状态
//   http(s) （学习通网页） → 暴露 __cxHost：GM_* 适配层（KV / 代发请求 / 视觉）
//
// 两者都开 contextIsolation，不向页面暴露 require/process。
// ---------------------------------------------------------------------------
const { contextBridge, ipcRenderer } = require('electron');

const isAppUi = (() => {
  try {
    return String(location.protocol) === 'file:';
  } catch (e) {
    return false;
  }
})();

if (isAppUi) {
  contextBridge.exposeInMainWorld('__cxApp', {
    // 网页控制
    goto: (url) => ipcRenderer.invoke('web:goto', url),
    home: () => ipcRenderer.invoke('web:home'),
    reload: () => ipcRenderer.invoke('web:reload'),
    back: () => ipcRenderer.invoke('web:back'),
    evalMain: (code) => ipcRenderer.invoke('web:eval', code),
    evalQuiz: (code) => ipcRenderer.invoke('web:evalQuiz', code),

    // 视觉
    askVision: (payload) => ipcRenderer.invoke('vision:ask', payload),
    visionStatus: () => ipcRenderer.invoke('vision:status'),

    // 运行状态（页面/标题）
    pageInfo: () => ipcRenderer.invoke('web:info'),
    appInfo: () => ipcRenderer.invoke('app:info'),

    // KV（面板保存设置）
    kvGet: (key, fallback) => {
      try {
        return ipcRenderer.sendSync('kv:get', String(key), fallback);
      } catch (e) {
        return fallback;
      }
    },
    kvSet: (key, value) => ipcRenderer.send('kv:set', String(key), value),

    onLog: (cb) => {
      const handler = (_e, line) => {
        try {
          cb(line);
        } catch (err) {
          /* ignore */
        }
      };
      ipcRenderer.on('ui:log', handler);
      return () => ipcRenderer.removeListener('ui:log', handler);
    },
  });
} else {
  contextBridge.exposeInMainWorld('__cxHost', {
    kvGet(key, fallback) {
      try {
        return ipcRenderer.sendSync('kv:get', String(key), fallback);
      } catch (e) {
        return fallback;
      }
    },
    kvSet(key, value) {
      try {
        ipcRenderer.send('kv:set', String(key), value);
        return true;
      } catch (e) {
        return false;
      }
    },
    xhr(options) {
      return ipcRenderer.invoke('net:xhr', options);
    },
    askVision(payload) {
      return ipcRenderer.invoke('vision:ask', payload);
    },
    visionStatus() {
      return ipcRenderer.invoke('vision:status');
    },
    registerMenu(label) {
      try {
        ipcRenderer.send('menu:register', String(label));
      } catch (e) {
        /* ignore */
      }
    },
  });

  // Sandboxed subframes have no Electron preload bridge. Relay only the fixed
  // course API from platform frames; never expose require or enable Node there.
  if (window === window.top && /(^|\.)(chaoxing|xuexitong)\.com$/i.test(location.hostname)) {
    window.addEventListener('message', async event => {
      const data = event.data;
      let origin;
      try { origin = new URL(event.origin); } catch { return; }
      if (!/^https?:$/.test(origin.protocol) || !/(^|\.)(chaoxing|xuexitong)\.com$/i.test(origin.hostname)) return;
      if (event.source === window || !event.source || !data || data.channel !== 'cx-host-request') return;
      if (typeof data.id !== 'string' || data.id.length > 100 || !Array.isArray(data.args)) return;
      const channels = { askVision: 'vision:ask', visionStatus: 'vision:status', xhr: 'net:xhr' };
      try {
        let result;
        if (data.method === 'kvSet') {
          ipcRenderer.send('kv:set', String(data.args[0]), data.args[1]); result = true;
        } else {
          if (!Object.prototype.hasOwnProperty.call(channels, data.method)) return;
          result = await ipcRenderer.invoke(channels[data.method], ...data.args);
        }
        event.source.postMessage({ channel: 'cx-host-reply', id: data.id, result }, event.origin);
      } catch {
        try { event.source.postMessage({ channel: 'cx-host-reply', id: data.id, error: 'App 调用失败' }, event.origin); } catch {}
      }
    });
  }
}
