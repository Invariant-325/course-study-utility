#!/usr/bin/env node
// ---------------------------------------------------------------------------
// vision-bridge-server.mjs —— 本地 HTTP 桥接（阶段 D2 集成用）
//
// 浏览器脚本不能直接起 node 子进程，所以这里提供一个只监听 127.0.0.1 的服务：
//   浏览器 → POST /vision（图片 + 题目 ID）→ 本服务 → dsh headless 视觉会话 → 校验后的 JSON
//
// 安全与资源边界：
//   - 只监听 127.0.0.1
//   - 每次启动生成随机 token，必须放在 X-Vision-Token 头里
//   - Origin 白名单：仅 *.chaoxing.com（GM 请求可能不带 Origin，以 token 为准）
//   - 图片 base64 上限 12 MiB、解码后 8 MiB、边长 ≤ 4096
//   - 单并发 + 队列上限 4，超出返回 429
//   - 单次会话超时 120s
//   - 临时图片与临时文件用完即删
//   - 日志脱敏：不记录图片内容、不记录 Key
//
// 凭据来源（解耦）：
//   VISION_API_KEY / DEEPSEEK_API_KEY 环境变量
//   --key-file <path>
//   --allow-dev-credentials（仅开发：读 DSH 凭据文件，发行版不要用）
//
// 用法：
//   node vision-bridge-server.mjs
//   node vision-bridge-server.mjs --port 8788 --key-file ./key.txt
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runVision, resolveApiKey, TMP_ROOT, WORKSPACE } from './vision-core.mjs';

const DEFAULT_PORT = 8788;
const MAX_BASE64 = 12 * 1024 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 4096;
const SESSION_TIMEOUT_MS = 120000;
const MAX_QUEUE = 4;

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*chaoxing\.com$/i;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, keyFile: '', allowDevCredentials: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (a === '--key-file') args.keyFile = argv[++i] || '';
    else if (a === '--allow-dev-credentials') args.allowDevCredentials = true;
  }
  return args;
}

const args = parseArgs(process.argv);
const TOKEN = randomBytes(24).toString('hex');
const startedAt = new Date().toISOString();

// PNG / JPEG 尺寸解析（只用于拒绝超大图）
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function send(res, status, data, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

let busy = false;
let queued = 0;

const server = createServer(async (req, res) => {
  const origin = String(req.headers.origin || '');

  if (req.method === 'OPTIONS') {
    if (origin && !ALLOWED_ORIGIN.test(origin)) {
      res.writeHead(403);
      res.end('Origin not allowed');
      return;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Vision-Token',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    res.end();
    return;
  }

  if (origin && !ALLOWED_ORIGIN.test(origin)) {
    send(res, 403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    const k = resolveApiKey({ keyFile: args.keyFile, allowDevCredentials: args.allowDevCredentials });
    send(res, 200, { ok: true, hasCredential: !!k.key, credentialSource: k.source, busy, queued, startedAt }, origin);
    return;
  }

  if (req.method !== 'POST' || req.url !== '/vision') {
    send(res, 404, { ok: false, error: 'NOT_FOUND' }, origin);
    return;
  }

  if (String(req.headers['x-vision-token'] || '') !== TOKEN) {
    send(res, 401, { ok: false, error: 'TOKEN_REQUIRED' }, origin);
    return;
  }

  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    send(res, 415, { ok: false, error: 'UNSUPPORTED_MEDIA_TYPE' }, origin);
    return;
  }

  if (busy) {
    if (queued >= MAX_QUEUE) {
      send(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' }, origin);
      return;
    }
    queued++;
    // 简单排队：等当前请求结束
    const waitStart = Date.now();
    while (busy && Date.now() - waitStart < SESSION_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 200));
    }
    queued--;
    if (busy) {
      send(res, 429, { ok: false, error: 'TIMEOUT_IN_QUEUE' }, origin);
      return;
    }
  }
  busy = true;

  let imagePath = '';
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString('utf8');
      if (raw.length > MAX_BASE64 * 1.4) {
        send(res, 413, { ok: false, error: 'BODY_TOO_LARGE' }, origin);
        return;
      }
    }

    let body = null;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      send(res, 400, { ok: false, error: 'INVALID_JSON' }, origin);
      return;
    }

    const questionId = String((body && body.questionId) || '').slice(0, 80);
    const base64 = String((body && body.imageBase64) || '');
    const allowedLetters = Array.isArray(body && body.allowedLetters)
      ? body.allowedLetters.map((x) => String(x).toUpperCase()).slice(0, 8)
      : [];

    if (!questionId || !/^[\w\-:.]{1,80}$/.test(questionId)) {
      send(res, 400, { ok: false, error: 'INVALID_QUESTION_ID' }, origin);
      return;
    }
    if (!base64) {
      send(res, 400, { ok: false, error: 'MISSING_IMAGE' }, origin);
      return;
    }
    if (base64.length > MAX_BASE64) {
      send(res, 413, { ok: false, error: 'IMAGE_TOO_LARGE' }, origin);
      return;
    }

    const payload = base64.replace(/^data:image\/[a-z]+;base64,/i, '');
    let buf = null;
    try {
      buf = Buffer.from(payload, 'base64');
    } catch (e) {
      send(res, 400, { ok: false, error: 'INVALID_BASE64' }, origin);
      return;
    }
    if (!buf || buf.length < 100) {
      send(res, 400, { ok: false, error: 'IMAGE_EMPTY' }, origin);
      return;
    }
    if (buf.length > MAX_BYTES) {
      send(res, 413, { ok: false, error: 'IMAGE_TOO_LARGE_BYTES' }, origin);
      return;
    }

    const size = imageSize(buf);
    if (!size) {
      send(res, 400, { ok: false, error: 'UNSUPPORTED_IMAGE_FORMAT' }, origin);
      return;
    }
    if (size.width > MAX_EDGE || size.height > MAX_EDGE) {
      send(res, 413, { ok: false, error: 'IMAGE_DIMENSION_EXCEEDED', width: size.width, height: size.height }, origin);
      return;
    }

    const key = resolveApiKey({ keyFile: args.keyFile, allowDevCredentials: args.allowDevCredentials });
    if (!key.key) {
      send(res, 503, { ok: false, error: 'MISSING_CREDENTIAL' }, origin);
      return;
    }

    mkdirSync(TMP_ROOT, { recursive: true });
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
    imagePath = join(TMP_ROOT, 'req-' + questionId.replace(/[^\w\-]/g, '_') + '-' + hash + '.png');
    writeFileSync(imagePath, buf);

    const result = await runVision({
      imagePath: imagePath,
      questionId: questionId,
      allowedLetters: allowedLetters,
      apiKey: key.key,
      timeoutMs: SESSION_TIMEOUT_MS,
    });

    // 日志脱敏：只记录题目 ID、耗时、状态，不记录图片与 Key
    console.log(
      '[vision] ' + new Date().toISOString() + ' id=' + questionId +
        ' ok=' + result.ok + ' status=' + (result.status || '-') +
        ' answers=' + (result.answers || []).join(',') +
        ' ' + (result.elapsedMs || 0) + 'ms'
    );

    send(res, result.ok ? 200 : 422, result, origin);
  } catch (error) {
    console.log('[vision] error: ' + (error && error.message));
    send(res, 500, { ok: false, error: 'INTERNAL_ERROR' }, origin);
  } finally {
    if (imagePath && existsSync(imagePath)) {
      try {
        rmSync(imagePath, { force: true });
      } catch (e) {}
    }
    busy = false;
  }
});

server.listen(args.port, '127.0.0.1', () => {
  const k = resolveApiKey({ keyFile: args.keyFile, allowDevCredentials: args.allowDevCredentials });
  console.log('视觉桥接服务已启动');
  console.log('  地址：http://127.0.0.1:' + args.port);
  console.log('  令牌：' + TOKEN);
  console.log('  凭据：' + (k.key ? k.source : '未配置（请设置 VISION_API_KEY）'));
  console.log('  工作区：' + WORKSPACE);
  console.log('  限制：单并发 / 队列 ' + MAX_QUEUE + ' / 超时 ' + SESSION_TIMEOUT_MS + 'ms / 边长 ≤ ' + MAX_EDGE);
  console.log('');
  console.log('把地址和令牌填进章节测验面板的「视觉识别」设置。');
  console.log('关闭本窗口即停止服务。');
});
