// ---------------------------------------------------------------------------
// llm.js —— OpenAI 兼容模型客户端（阶段 D）
//
// 硬性约束（与阶段 B v2 §7 一致）：
//   R1 所有外部 HTTP 只走 GM_xmlhttpRequest，**不用页面 fetch**
//      （https 页面 fetch 到 127.0.0.1 会触发 PNA 预检，且受 CORS/混合内容限制）
//   R2 不使用 @connect *
//   R3 默认本地代理 http://127.0.0.1:8787
//   R4 直连模式需用户自行在脚本头追加 @connect <域名>
//   R5 不申请额外 GM 权限
//
// 安全：
//   - API Key 只进 GM 隔离存储，非油猴环境拒绝保存（Config.set 已强制）
//   - 模型输出必须严格 JSON，绝不 eval / new Function / 执行返回的代码
//   - 并发锁 + 题目 hash 缓存 + 有限重试，杜绝无限消耗
// ---------------------------------------------------------------------------
const Llm = (function () {
  const STATS = {
    requests: 0,
    successes: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    lastError: '',
    lastAt: 0,
  };

  let busy = false;
  let inflight = null;
  const cache = new Map(); // hash -> { ok, payload, at }

  const SYSTEM_PROMPT = [
    '你是一个课程测验辅助器。只输出一个 JSON 对象，不要输出任何解释性文字或 Markdown 代码块。',
    'JSON 结构必须是：{"answer":["A"],"reason":"简要理由","confidence":0.0,"uncertain":false}',
    '规则：',
    '1. answer 只能是给定选项字母组成的数组，绝不能出现给定选项之外的字母。',
    '2. 单选题与判断题必须且只能给 1 个字母。',
    '3. 多选题给 1 个或多个字母。',
    '4. confidence 是 0 到 1 的数字，表示你对答案的把握。',
    '5. 若题目信息不足或你不确定，把 uncertain 设为 true，并在 reason 里说明缺什么。',
    '6. 不要编造选项，不要输出题目以外的内容。',
  ].join('\n');

  function stats() {
    return Object.assign({}, STATS);
  }

  function isBusy() {
    return busy;
  }

  function readConfig() {
    return {
      enabled: Config.get('llmEnabled') === true,
      mode: Config.get('llmMode') === 'direct' ? 'direct' : 'proxy',
      proxyUrl: String(Config.get('llmProxyUrl') || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
      proxyToken: String(Config.get('llmProxyToken') || ''),
      baseUrl: String(Config.get('llmBaseUrl') || '').replace(/\/+$/, ''),
      model: String(Config.get('llmModel') || ''),
      apiKey: String(Config.get('llmApiKey') || ''),
      temperature: Number(Config.get('llmTemperature')),
      timeoutMs: Number(Config.get('llmTimeoutMs')) || 45000,
      maxRetries: Number(Config.get('llmMaxRetries')),
    };
  }

  // 唯一的网络出口。没有 GM_xmlhttpRequest 时直接失败，绝不回退到页面 fetch。
  function gmRequest(options) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用：请用 Tampermonkey 安装本脚本，页面控制台注入无法发请求'));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: options.method || 'POST',
          url: options.url,
          headers: options.headers || {},
          data: options.data,
          timeout: options.timeout || 45000,
          onload: function (res) {
            resolve({ status: res.status, text: String(res.responseText || '') });
          },
          onerror: function () {
            reject(new Error('网络错误'));
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

  // 严格提取 JSON：只接受"{...}"结构，不执行任何表达式
  function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('模型返回为空');

    // 去掉 ```json ... ``` 包裹
    let body = raw;
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) body = fence[1].trim();

    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('模型返回不含 JSON 对象');
    }
    const slice = body.slice(start, end + 1);
    if (slice.length > 4000) throw new Error('模型返回 JSON 过大，已拒绝');

    const parsed = JSON.parse(slice);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模型返回的 JSON 不是对象');
    }
    return parsed;
  }

  function buildMessages(payload) {
    const userContent = [
      '题型：' + payload.typeLabel,
      '题干：' + payload.stem,
      '选项：',
    ]
      .concat(
        payload.options.map(function (option) {
          return option.letter + '. ' + option.text;
        })
      )
      .join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];
  }

  async function callOnce(cfg, messages) {
    const isProxy = cfg.mode === 'proxy';
    const url = isProxy ? cfg.proxyUrl + '/ask' : cfg.baseUrl + '/chat/completions';

    if (!isProxy && !cfg.baseUrl) throw new Error('未配置 Base URL');
    if (!isProxy && !cfg.apiKey) throw new Error('未配置 API Key');

    const body = isProxy
      ? JSON.stringify({
          token: cfg.proxyToken,
          model: cfg.model || undefined,
          temperature: cfg.temperature,
          messages: messages,
        })
      : JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          temperature: cfg.temperature,
          messages: messages,
          response_format: { type: 'json_object' },
        });

    const headers = { 'Content-Type': 'application/json' };
    if (!isProxy) headers.Authorization = 'Bearer ' + cfg.apiKey;

    const response = await gmRequest({
      method: 'POST',
      url: url,
      headers: headers,
      data: body,
      timeout: cfg.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
      const short = response.text.slice(0, 200);
      throw new Error('HTTP ' + response.status + '：' + short);
    }

    let envelope = null;
    try {
      envelope = JSON.parse(response.text);
    } catch (e) {
      throw new Error('响应不是合法 JSON');
    }

    // 代理模式：{ content, usage }；直连模式：OpenAI 标准结构
    let content = '';
    let usage = null;
    if (envelope && typeof envelope.content === 'string') {
      content = envelope.content;
      usage = envelope.usage || null;
    } else if (envelope && envelope.choices && envelope.choices[0] && envelope.choices[0].message) {
      content = String(envelope.choices[0].message.content || '');
      usage = envelope.usage || null;
    } else if (envelope && typeof envelope.error === 'string') {
      throw new Error('模型返回错误：' + envelope.error.slice(0, 160));
    } else {
      throw new Error('响应结构无法识别');
    }

    return { content: content, usage: usage };
  }

  /**
   * 请求一次答案建议。
   * @param {object} question QuizModel.parse() 的成功结果
   * @returns {Promise<{ok:boolean, payload:object|null, error:string, cached:boolean}>}
   */
  async function ask(question) {
    const cfg = readConfig();

    if (!cfg.enabled) return { ok: false, payload: null, error: 'AI 未开启', cached: false };

    if (question && question.hash && cache.has(question.hash)) {
      const hit = cache.get(question.hash);
      Log.debug('命中题目缓存：' + question.hash);
      return { ok: true, payload: hit.payload, error: '', cached: true };
    }

    // 并发锁：同一时刻只允许一个模型请求
    if (busy) return { ok: false, payload: null, error: '上一个请求仍在进行', cached: false };
    busy = true;

    const payload = QuizModel.toPromptPayload(question);
    const messages = buildMessages(payload);
    const attempts = Math.max(0, Math.min(5, isFinite(cfg.maxRetries) ? cfg.maxRetries : 2));

    let lastError = '';
    inflight = { startedAt: Date.now(), hash: question.hash };

    try {
      for (let i = 0; i <= attempts; i++) {
        STATS.requests++;
        STATS.lastAt = Date.now();
        try {
          const result = await callOnce(cfg, messages);

          if (result.usage) {
            STATS.promptTokens += Number(result.usage.prompt_tokens) || 0;
            STATS.completionTokens += Number(result.usage.completion_tokens) || 0;
          }

          const parsed = extractJson(result.content);
          const validated = QuizModel.validateAnswer(question, parsed);

          if (!validated.ok) {
            lastError = '答案校验失败：' + validated.errors.join('；');
            Log.warn(lastError);
            // 校验失败不重试：重试同样内容大概率仍不合法，且会浪费 token
            STATS.failures++;
            STATS.lastError = lastError;
            return { ok: false, payload: null, error: lastError, cached: false };
          }

          const finalPayload = {
            letters: validated.letters,
            reason: validated.reason,
            confidence: validated.confidence,
            uncertain: validated.uncertain,
            type: question.type,
            at: Date.now(),
          };

          cache.set(question.hash, { ok: true, payload: finalPayload, at: Date.now() });
          if (cache.size > 100) cache.delete(cache.keys().next().value);

          STATS.successes++;
          return { ok: true, payload: finalPayload, error: '', cached: false };
        } catch (error) {
          lastError = (error && error.message) || '未知错误';
          STATS.failures++;
          STATS.lastError = lastError;
          const retriable = i < attempts && !/未配置|不可用|校验失败/.test(lastError);
          Log.warn('模型请求失败（第 ' + (i + 1) + '/' + (attempts + 1) + ' 次）：' + lastError);
          if (!retriable) break;
          await Dom.waitTimeout(800 + i * 600);
        }
      }

      // 失败结果也缓存，避免同一题反复烧 token
      cache.set(question.hash, { ok: false, payload: null, at: Date.now(), error: lastError });
      return { ok: false, payload: null, error: lastError || '请求失败', cached: false };
    } finally {
      busy = false;
      inflight = null;
    }
  }

  function clearCache() {
    cache.clear();
  }

  function resetStats() {
    STATS.requests = 0;
    STATS.successes = 0;
    STATS.failures = 0;
    STATS.promptTokens = 0;
    STATS.completionTokens = 0;
    STATS.lastError = '';
  }

  return {
    ask,
    stats,
    isBusy,
    clearCache,
    resetStats,
    readConfig,
    extractJson, // 暴露给单测
  };
})();
