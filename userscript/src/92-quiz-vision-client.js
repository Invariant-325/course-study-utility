// ---------------------------------------------------------------------------
// quiz-vision-client.js —— 浏览器端调用本地视觉桥接
//
// 只走 GM_xmlhttpRequest（与 D1 的 Llm 保持同一原则，不用页面 fetch）。
// 桥接地址与令牌来自配置，默认 http://127.0.0.1:8788。
//
// 每次请求携带：
//   questionId     由 DOM 侧维护的稳定题目 ID（不是视觉推测的题号）
//   allowedLetters 页面实际存在的选项字母（用于服务端与客户端双重校验）
//   imageBase64    Canvas 渲染出的 PNG dataURL
// ---------------------------------------------------------------------------
const QuizVision = (function () {
  const STATS = { requests: 0, successes: 0, failures: 0, lastError: '', lastElapsedMs: 0 };

  let busy = false;

  function readConfig() {
    return {
      enabled: !!window.__cxHost || Config.get('visionEnabled') === true,
      url: String(Config.get('visionBridgeUrl') || 'http://127.0.0.1:8788').replace(/\/+$/, ''),
      token: String(Config.get('visionBridgeToken') || ''),
      timeoutMs: Number(Config.get('visionTimeoutMs')) || 130000,
    };
  }

  function stats() {
    return Object.assign({}, STATS);
  }

  function gmPost(url, headers, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用'));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: url,
          headers: headers,
          data: body,
          timeout: timeoutMs,
          onload: function (res) {
            resolve({ status: res.status, text: String(res.responseText || '') });
          },
          onerror: function () {
            reject(new Error('网络错误：桥接服务是否在运行？'));
          },
          ontimeout: function () {
            reject(new Error('请求超时'));
          },
          onabort: function () {
            reject(new Error('请求已取消'));
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 请求视觉作答。
   * @param {string} imageDataUrl Canvas 生成的 PNG dataURL
   * @param {string} questionId 稳定题目 ID
   * @param {string[]} allowedLetters 页面实际选项字母
   */
  async function ask(imageDataUrl, questionId, allowedLetters) {
    const cfg = readConfig();
    if (!cfg.enabled) return { ok: false, error: '视觉识别未开启', answers: [], status: 'unreadable' };
    if (!imageDataUrl) return { ok: false, error: '没有图片', answers: [], status: 'unreadable' };
    if (busy) return { ok: false, error: '上一个视觉请求仍在进行', answers: [], status: 'unreadable' };

    busy = true;
    STATS.requests++;
    const started = Date.now();

    try {
      const body = JSON.stringify({
        questionId: questionId,
        imageBase64: imageDataUrl,
        allowedLetters: allowedLetters || [],
      });

      // Desktop uses its built-in host, not the optional Tampermonkey HTTP bridge.
      const nativeResult = window.__cxHost ? await window.__cxHost.askVision({ questionId, imageBase64: imageDataUrl, allowedLetters: allowedLetters || [] }) : null;
      const res = nativeResult ? { status: 200, text: JSON.stringify(nativeResult) } : await gmPost(
        cfg.url + '/vision',
        { 'Content-Type': 'application/json', 'X-Vision-Token': cfg.token },
        body,
        cfg.timeoutMs
      );

      STATS.lastElapsedMs = Date.now() - started;

      let data = null;
      try {
        data = JSON.parse(res.text);
      } catch (e) {
        STATS.failures++;
        STATS.lastError = '桥接返回非 JSON（HTTP ' + res.status + '）';
        return { ok: false, error: STATS.lastError, answers: [], status: 'unreadable' };
      }

      if (res.status !== 200) {
        STATS.failures++;
        STATS.lastError = (data && data.error) || 'HTTP ' + res.status;
        return {
          ok: false,
          error: STATS.lastError,
          answers: [],
          status: 'unreadable',
          httpStatus: res.status,
        };
      }

      if(data?.ok===false){const reason=data.error||(data.errors||[]).join('；')||('视觉识别未取得答案（'+(data.status||'未知原因')+'）');STATS.failures++;STATS.lastError=reason;return {ok:false,error:reason,answers:[],status:data.status||'unreadable',elapsedMs:data.elapsedMs||STATS.lastElapsedMs};}

      // 客户端二次校验：题目 ID 必须回显一致，选项必须在允许集合内
      const errors = [];
      if (String(data.questionId || '') !== String(questionId)) {
        errors.push('questionId 不一致');
      }
      const allowed = new Set((allowedLetters || []).map(function (l) { return String(l).toUpperCase(); }));
      let answers = Array.isArray(data.answers) ? data.answers.map(function (a) { return String(a).toUpperCase(); }) : [];
      if (allowed.size) {
        const bad = answers.filter(function (a) { return !allowed.has(a); });
        if (bad.length) errors.push('选项不存在：' + bad.join(','));
        answers = answers.filter(function (a) { return allowed.has(a); });
      }

      if (errors.length) {
        STATS.failures++;
        STATS.lastError = errors.join('；');
        return { ok: false, error: STATS.lastError, answers: answers, status: 'unreadable' };
      }

      const ok = data.ok === true && data.status === 'ok';
      if (ok) STATS.successes++;
      else {
        STATS.failures++;
        STATS.lastError = data.status || '未识别';
      }

      return {
        ok: ok,
        status: data.status || 'unreadable',
        type: data.type || 'unknown',
        answers: answers,
        errors: data.errors || [],
        elapsedMs: data.elapsedMs || STATS.lastElapsedMs,
      };
    } catch (error) {
      STATS.failures++;
      STATS.lastError = (error && error.message) || '请求失败';
      return { ok: false, error: STATS.lastError, answers: [], status: 'unreadable' };
    } finally {
      busy = false;
    }
  }

  async function health() {
    const cfg = readConfig();
    try {
      if (window.__cxHost) {
        const data = await window.__cxHost.visionStatus();
        return { ok: data.dshFound && data.hasKey, data };
      }
      const res = await new Promise(function (resolve, reject) {
        if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no GM'));
        GM_xmlhttpRequest({
          method: 'GET',
          url: cfg.url + '/health',
          timeout: 5000,
          onload: function (r) {
            resolve({ status: r.status, text: String(r.responseText || '') });
          },
          onerror: function () {
            reject(new Error('连接失败'));
          },
          ontimeout: function () {
            reject(new Error('超时'));
          },
        });
      });
      const data = JSON.parse(res.text);
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'unknown' };
    }
  }

  return {
    ask,
    health,
    stats,
    readConfig,
    isBusy() {
      return busy;
    },
  };
})();
