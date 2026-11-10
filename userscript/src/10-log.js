// ---------------------------------------------------------------------------
// log.js —— 分级日志：环形缓冲 + 订阅（供面板展示）
// 不打印任何账号信息；只记录 DOM 选择器命中与状态流转。
// ---------------------------------------------------------------------------
const Log = (function () {
  const MAX_RECORDS = 300;
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const records = [];
  const listeners = new Set();
  let minLevel = LEVELS.info;

  function timeText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function emit(level, message, detail) {
    const record = { at: Date.now(), time: timeText(), level: level, message: String(message) };
    if (detail !== undefined) record.detail = detail;
    records.push(record);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);

    if (LEVELS[level] >= minLevel) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink.call(console, '[学习通助手][' + record.time + '][' + level + '] ' + record.message);
    }
    for (const listener of listeners) {
      try {
        listener(record);
      } catch (e) {
        /* 面板异常不得影响主流程 */
      }
    }
    return record;
  }

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    setDebug(on) {
      minLevel = on ? LEVELS.debug : LEVELS.info;
    },
    isDebug() {
      return minLevel === LEVELS.debug;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    recent(count) {
      return records.slice(Math.max(0, records.length - (count || 50)));
    },
    all() {
      return records.slice();
    },
    clear() {
      records.length = 0;
    },
  };
})();
