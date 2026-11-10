#!/usr/bin/env node
// ---------------------------------------------------------------------------
// quiz-proxy.mjs —— 弹题 AI 的本地代理（阶段 D1）
//
// 为什么需要它：
//   用户脚本里放 API Key 有两个问题——写进脚本源会被分发，写进 localStorage
//   会被页面脚本读到。本代理把 Key 留在本机进程内存里，脚本只持有一个随机
//   token，且只访问 127.0.0.1。
//
// 安全模型：
//   1. 只监听 127.0.0.1，不对外网开放
//   2. 随机 24 字节 token，每次启动重新生成，启动时打印给用户填进面板
//   3. Origin 白名单：仅 *.chaoxing.com（GM 请求可能不带 Origin，此时以 token 为准）
//   4. 严格请求体校验（大小、结构、字段类型），不合格直接 400
//   5. 串行互斥，避免并发把额度打爆
//   6. Key 只从环境变量或交互输入读取，绝不写盘、绝不回显
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node proxy/quiz-proxy.mjs
//   node proxy/quiz-proxy.mjs                       # 交互式输入 Key（不回显）
//
// 可选环境变量：QUIZ_PROXY_PORT / QUIZ_BASE_URL / QUIZ_MODEL / QUIZ_PROXY_TOKEN
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const PORT = Number(process.env.QUIZ_PROXY_PORT || 8787);
const TOKEN = String(process.env.QUIZ_PROXY_TOKEN || randomBytes(24).toString('hex'));
const BASE_URL = String(process.env.QUIZ_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const DEFAULT_MODEL = String(process.env.QUIZ_MODEL || 'deepseek-chat');
const MAX_BODY = 64 * 1024;
const MAX_MESSAGES = 3;
const MAX_CONTENT = 8000;

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com$/i;

async function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  if (process.env.QUIZ_API_KEY) return process.env.QUIZ_API_KEY.trim();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const value = await rl.question('请输入 AI API Key（直接回车用环境变量 DEEPSEEK_API_KEY）：');
  rl.close();
  return value.trim();
}

function send(res, status, data, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) return false;
  return messages.every(function (message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role !== 'user' && message.role !== 'system') return false;
    if (typeof message.content !== 'string') return false;
    if (message.content.length === 0 || message.content.length > MAX_CONTENT) return false;
    return true;
  });
}

const apiKey = await readApiKey();
if (!apiKey) {
  console.error('未提供 API Key，退出。请设置 DEEPSEEK_API_KEY 或交互输入。');
  process.exit(1);
}

let busy = false;

const server = createServer(async function (req, res) {
  const origin = String(req.headers.origin || '');

  // 预检
  if (req.method === 'OPTIONS') {
    if (origin && !ALLOWED_ORIGIN.test(origin)) {
      res.writeHead(403);
      res.end('Origin not allowed');
      return;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Quiz-Token',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    res.end();
    return;
  }

  // Origin 存在时必须合法；不存在（油猴 GM 请求）以 token 为准
  if (origin && !ALLOWED_ORIGIN.test(origin)) {
    send(res, 403, { error: 'Origin 不被允许' }, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { ok: true, model: DEFAULT_MODEL }, origin);
    return;
  }

  if (req.method !== 'POST' || req.url !== '/ask') {
    send(res, 404, { error: '未找到接口' }, origin);
    return;
  }

  const providedToken = String(req.headers['x-quiz-token'] || '');
  if (providedToken !== TOKEN) {
    send(res, 403, { error: '令牌不匹配，请复制代理启动时打印的 token' }, origin);
    return;
  }

  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    send(res, 415, { error: '仅接受 application/json' }, origin);
    return;
  }

  if (busy) {
    send(res, 429, { error: '上一个请求仍在处理' }, origin);
    return;
  }
  busy = true;

  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString('utf8');
      if (raw.length > MAX_BODY) throw new Error('请求体过大');
    }

    let body = null;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      send(res, 400, { error: '请求体不是合法 JSON' }, origin);
      return;
    }

    if (!validMessages(body && body.messages)) {
      send(res, 400, { error: 'messages 结构不合法' }, origin);
      return;
    }

    const model = String(body.model || DEFAULT_MODEL).slice(0, 80);
    const temperature = Number.isFinite(Number(body.temperature))
      ? Math.max(0, Math.min(1.5, Number(body.temperature)))
      : 0.2;

    const upstream = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model,
        temperature: temperature,
        messages: body.messages,
        response_format: { type: 'json_object' },
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60000),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      send(res, 502, { error: '上游 HTTP ' + upstream.status + '：' + text.slice(0, 200) }, origin);
      return;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      send(res, 502, { error: '上游返回非 JSON' }, origin);
      return;
    }

    const choice = parsed && parsed.choices && parsed.choices[0];
    const content = choice && choice.message ? String(choice.message.content || '') : '';
    if (!content) {
      send(res, 502, { error: '上游未返回内容' }, origin);
      return;
    }

    send(res, 200, { content: content, usage: parsed.usage || null, model: model }, origin);
  } catch (error) {
    send(res, 502, { error: (error && error.message) || '代理内部错误' }, origin);
  } finally {
    busy = false;
  }
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('弹题 AI 代理已启动');
  console.log('  地址：http://127.0.0.1:' + PORT);
  console.log('  令牌：' + TOKEN);
  console.log('  上游：' + BASE_URL + '（模型 ' + DEFAULT_MODEL + '）');
  console.log('');
  console.log('把上面的地址和令牌填进脚本面板的「AI 设置」，然后勾选「启用」。');
  console.log('API Key 只在本进程内存中，不会写入磁盘，也不会进入网页。');
  console.log('关闭本窗口即停止服务。');
});
