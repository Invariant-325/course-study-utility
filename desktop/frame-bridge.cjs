// Serialized into the page world; no Node access in course frames.
function installFrameBridge(topOrigin, values) {
  if (window.__cxHost || window === window.top) return;
  let sequence = 0;
  const pending = new Map();
  const prefix = 'cx-' + Math.random().toString(36).slice(2) + '-';
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window.top || event.origin !== topOrigin || !data || data.channel !== 'cx-host-reply') return;
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id); clearTimeout(item.timer);
    data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
  });
  function request(method, args) {
    return new Promise((resolve, reject) => {
      const id = prefix + (++sequence);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('App 调用超时')); }, 135000);
      pending.set(id, { resolve, reject, timer });
      window.top.postMessage({ channel: 'cx-host-request', id, method, args }, topOrigin);
    });
  }
  window.__cxHost = {
    kvGet: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
    kvSet: (key, value) => { values[key] = value; request('kvSet', [key, value]).catch(() => {}); return true; },
    xhr: options => request('xhr', [options]),
    askVision: payload => request('askVision', [payload]),
    visionStatus: () => request('visionStatus', []),
    registerMenu: () => {},
  };
}
module.exports = { installFrameBridge };
