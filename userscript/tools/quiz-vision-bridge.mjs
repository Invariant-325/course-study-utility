#!/usr/bin/env node
// ---------------------------------------------------------------------------
// quiz-vision-bridge.mjs —— 视觉答题本地桥接（阶段 D2 新方案）
//
// 职责：把「题目截图 + 题目 ID」交给一个**独立的 DSH 会话**（dsh --profile headless），
// 由 DeepSeek V4.1 Flash（deepseek-flash, reasoningEffort=low）识图作答，取回严格 JSON。
//
// 为什么用 dsh headless 而不是 SDK：
//   - @deepseek-ai/dsh-sdk-client 通过 **stdio JSON-RPC** 驱动子进程；
//   - 本机沙箱禁止创建管道（spawn + stdio:'pipe' → EPERM）；
//   - dsh headless 是「回答一个任务并退出」，用 **文件描述符重定向** 即可，不需要管道。
//   实测：`--dump-config` 确认 headless 默认就是 provider=deepseek-official / model=deepseek-flash，
//   再通过 profile 的 cordis.patch.yml 固定 reasoningEffort=low。
//
// 隔离与安全：
//   - 独立 DSH_HOME（不污染桌面版 profile）
//   - --permission-mode read-only + --approval-policy never（无人值守且不能写入）
//   - 会话与当前 Coding Agent 的上下文完全分离
//   - 只读取工作区内的截图，不执行浏览器操作
//
// 用法：
//   node quiz-vision-bridge.mjs --image a.png --id q_001
//   node quiz-vision-bridge.mjs --image a.png --id q_001 --json
//
// 环境：
//   DEEPSEEK_API_KEY   必须（headless 的 credentials 插件被禁用，只认环境变量）
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '../..');
const DSH_CMD =
  'C:/Users/Invariant/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';
const DSH_HOME = join(HERE, '..', '..', '.dsh-home');
const TMP = join(HERE, '..', '..', '_probe', 'vision');

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
  '',
  '字段说明：questionId 原样返回调用方提供的 ID；type 为 single/multiple/true_false/unknown；',
  'answers 为选项字母数组；status 为 ok/uncertain/unreadable。不确定或识别失败时 answers 为空数组。',
].join('\n');

function parseArgs(argv) {
  const args = { image: '', id: '', json: false, timeoutMs: 180000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--image') args.image = argv[++i] || '';
    else if (a === '--id') args.id = argv[++i] || '';
    else if (a === '--json') args.json = true;
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]) || args.timeoutMs;
  }
  return args;
}

// 复用 DSH 已保存的凭据（~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY）。
// headless profile 的 credentials 插件被禁用，因此必须转成环境变量注入。
// 安全：只在本进程内传递，不打印、不写日志、不回显。
function loadKeyFromCredentialStore() {
  try {
    const paths = [
      join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml'),
      join(process.env.HOME || '', '.dsh', '.credentials.yaml'),
    ];
    for (const p of paths) {
      if (!p || !existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
      if (m && m[1]) return m[1];
    }
  } catch (e) {
    /* 静默失败：不给上层泄露路径信息 */
  }
  return '';
}

function buildTask(imageAbs, questionId) {
  return [
    SYSTEM_TASK,
    '',
    '题目 ID：' + questionId,
    '题目截图（绝对路径）：' + imageAbs,
    '请读取该图片并作答。',
  ].join('\n');
}

// 严格提取 JSON：只接受 {...}，绝不执行任何东西
export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('会话输出为空');
  let body = raw;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('输出中不含 JSON 对象');
  const slice = body.slice(start, end + 1);
  if (slice.length > 4000) throw new Error('JSON 过大，已拒绝');
  const parsed = JSON.parse(slice);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 不是对象');
  }
  return parsed;
}

const TYPES = new Set(['single', 'multiple', 'true_false', 'unknown']);
const STATUS = new Set(['ok', 'uncertain', 'unreadable']);

/**
 * 校验会话返回，并绑定回题目 ID。
 * @param {any} raw
 * @param {string} expectId
 * @param {string[]} allowedLetters 页面实际存在的选项字母
 */
export function validateResult(raw, expectId, allowedLetters) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, status: 'unreadable', answers: [], errors: ['结果不是对象'] };

  const id = String(raw.questionId || '');
  if (id !== expectId) errors.push('questionId 不匹配：期望 ' + expectId + '，实际 ' + id);

  const type = String(raw.type || '').toLowerCase();
  if (!TYPES.has(type)) errors.push('非法 type：' + type);

  const status = String(raw.status || '').toLowerCase();
  if (!STATUS.has(status)) errors.push('非法 status：' + status);

  let answers = [];
  if (Array.isArray(raw.answers)) {
    answers = raw.answers.map((x) => String(x).trim().toUpperCase());
  } else {
    errors.push('answers 不是数组');
  }

  // 只保留单字母
  const malformed = answers.filter((a) => !/^[A-H]$/.test(a));
  if (malformed.length) errors.push('非法选项格式：' + malformed.join(','));
  answers = answers.filter((a) => /^[A-H]$/.test(a));

  const allowed = new Set(allowedLetters || []);
  const notExist = answers.filter((a) => allowed.size && !allowed.has(a));
  if (notExist.length) errors.push('选项不存在：' + notExist.join(','));
  answers = answers.filter((a) => !allowed.size || allowed.has(a));
  answers = Array.from(new Set(answers));

  if ((type === 'single' || type === 'true_false') && answers.length > 1) {
    errors.push('单选/判断题返回多个答案');
    answers = answers.slice(0, 1);
  }
  if (status === 'ok' && answers.length === 0) errors.push('status=ok 但答案为空');

  return {
    ok: errors.length === 0 && status === 'ok',
    status: status || 'unreadable',
    type: type || 'unknown',
    answers: answers,
    errors: errors,
  };
}

function runHeadless(task, timeoutMs) {
  return new Promise((resolvePromise) => {
    mkdirSync(TMP, { recursive: true });
    const stamp = Date.now();
    const taskFile = join(TMP, 'task-' + stamp + '.txt');
    const outFile = join(TMP, 'out-' + stamp + '.txt');
    const errFile = join(TMP, 'err-' + stamp + '.txt');

    writeFileSync(taskFile, task, 'utf8');
    const inFd = openSync(taskFile, 'r');
    const outFd = openSync(outFile, 'w');
    const errFd = openSync(errFile, 'w');

    const env = Object.assign({}, process.env, { DSH_HOME: DSH_HOME });
    const child = spawn('cmd.exe', ['/c', DSH_CMD, '--profile', 'headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'], {
      cwd: WORKSPACE,
      env: env,
      stdio: [inFd, outFd, errFd],
    });

    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      try {
        closeSync(inFd);
      } catch (e) {}
      try {
        closeSync(outFd);
      } catch (e) {}
      try {
        closeSync(errFd);
      } catch (e) {}
      const out = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
      const err = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
      resolvePromise({ code: code, stdout: out, stderr: err });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {}
      finish(-1);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      finish(-2);
      console.error('spawn error:', e.code, e.message);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === null ? -3 : code);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.image || !args.id) {
    console.error('用法: node quiz-vision-bridge.mjs --image <png> --id <questionId> [--json]');
    process.exit(2);
  }
  const imageAbs = resolve(WORKSPACE, args.image);
  if (!existsSync(imageAbs)) {
    console.error('截图不存在: ' + imageAbs);
    process.exit(2);
  }

  // Key 优先级：环境变量 > DSH 已保存的凭据
  let apiKey = process.env.DEEPSEEK_API_KEY || '';
  let keySource = apiKey ? 'env' : '';
  if (!apiKey) {
    apiKey = loadKeyFromCredentialStore();
    keySource = apiKey ? 'credentials-store' : '';
  }
  if (!apiKey) {
    console.error(
      '缺少 DEEPSEEK_API_KEY：headless 的 credentials 插件被禁用，只能从环境变量读取。\n' +
        '请设置后重试：$env:DEEPSEEK_API_KEY="sk-..."'
    );
    process.exit(3);
  }
  process.env.DEEPSEEK_API_KEY = apiKey;

  const task = buildTask(imageAbs, args.id);
  const started = Date.now();
  const result = await runHeadless(task, args.timeoutMs);
  const elapsed = Date.now() - started;

  const payload = {
    questionId: args.id,
    keySource: keySource,
    exitCode: result.code,
    elapsedMs: elapsed,
    raw: result.stdout.trim().slice(0, 2000),
    stderr: result.stderr.trim().slice(-1200),
  };

  if (result.code !== 0) {
    console.log(JSON.stringify(Object.assign({ ok: false, error: '会话退出码 ' + result.code }, payload), null, 2));
    process.exit(1);
  }

  try {
    const parsed = extractJson(result.stdout);
    const check = validateResult(parsed, args.id, []);
    console.log(
      JSON.stringify(
        Object.assign(
          {
            ok: check.ok,
            status: check.status,
            type: check.type,
            answers: check.answers,
            errors: check.errors,
            parsed: parsed,
          },
          payload
        ),
        null,
        2
      )
    );
    process.exit(check.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify(Object.assign({ ok: false, error: e.message }, payload), null, 2));
    process.exit(1);
  }
}

if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  main();
}
