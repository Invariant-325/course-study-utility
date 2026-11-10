// ---------------------------------------------------------------------------
// vision-core.mjs —— 视觉答题核心（被 CLI 与 HTTP 服务共用）
//
// 职责边界：
//   - 组装任务提示词
//   - 通过 dsh headless（文件描述符重定向，不用管道）启动独立会话
//   - 严格解析与校验返回 JSON
//
// 不做的事：不读浏览器、不写页面、不决定题目对应关系（由调用方维护 questionId）。
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = resolve(HERE, '../..');
export const DSH_CMD =
  'C:/Users/Invariant/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';
export const DSH_HOME = join(WORKSPACE, '.dsh-home');
export const TMP_ROOT = join(WORKSPACE, '_probe', 'vision');

export const SYSTEM_TASK = [
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

const TYPES = new Set(['single', 'multiple', 'true_false', 'unknown']);
const STATUS = new Set(['ok', 'uncertain', 'unreadable']);

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

/**
 * 校验会话返回并绑定题目 ID。
 * @param {any} raw 解析后的对象
 * @param {string} expectId 调用方提供的题目 ID
 * @param {string[]} allowedLetters 页面实际存在的选项字母（空数组表示不校验）
 */
export function validateResult(raw, expectId, allowedLetters) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 'unreadable', type: 'unknown', answers: [], errors: ['结果不是对象'] };
  }

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

/**
 * 凭据来源解耦（要求 6）：
 *   1. 环境变量 VISION_API_KEY / DEEPSEEK_API_KEY（发行版推荐）
 *   2. 显式 --key-file 指定的文件（第一行或 KEY=value）
 *   3. 仅开发环境：DSH 凭据文件（默认关闭，需 VISION_ALLOW_DSH_CREDENTIALS=1 显式开启）
 * 任何情况下都不打印 Key。
 */
export function resolveApiKey(options) {
  const opts = options || {};

  const fromEnv = process.env.VISION_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  if (fromEnv) return { key: fromEnv, source: 'env' };

  if (opts.keyFile && existsSync(opts.keyFile)) {
    try {
      const text = readFileSync(opts.keyFile, 'utf8');
      const m = text.match(/^\s*(?:DEEPSEEK_API_KEY|VISION_API_KEY|API_KEY)\s*[=:]\s*(\S+)\s*$/m);
      const value = m ? m[1] : text.trim().split(/\r?\n/)[0].trim();
      if (value) return { key: value, source: 'key-file' };
    } catch (e) {
      /* ignore */
    }
  }

  if (opts.allowDevCredentials || process.env.VISION_ALLOW_DSH_CREDENTIALS === '1') {
    for (const base of [process.env.USERPROFILE, process.env.HOME]) {
      if (!base) continue;
      const p = join(base, '.dsh', '.credentials.yaml');
      if (!existsSync(p)) continue;
      try {
        const text = readFileSync(p, 'utf8');
        const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
        if (m && m[1]) return { key: m[1], source: 'dev-dsh-credentials' };
      } catch (e) {
        /* ignore */
      }
    }
  }

  return { key: '', source: '' };
}

function buildTask(imageAbs, questionId) {
  return [SYSTEM_TASK, '', '题目 ID：' + questionId, '题目截图（绝对路径）：' + imageAbs, '请读取该图片并作答。'].join('\n');
}

/**
 * 跑一次独立 DSH 会话。
 * 用文件描述符重定向（本沙箱禁止管道），临时文件在结束后删除。
 */
export function runHeadless(task, timeoutMs) {
  return new Promise((resolvePromise) => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const taskFile = join(TMP_ROOT, 'task-' + stamp + '.txt');
    const outFile = join(TMP_ROOT, 'out-' + stamp + '.txt');
    const errFile = join(TMP_ROOT, 'err-' + stamp + '.txt');

    writeFileSync(taskFile, task, 'utf8');
    const inFd = openSync(taskFile, 'r');
    const outFd = openSync(outFile, 'w');
    const errFd = openSync(errFile, 'w');

    const env = Object.assign({}, process.env, { DSH_HOME: DSH_HOME });
    const child = spawn(
      'cmd.exe',
      ['/c', DSH_CMD, '--profile', 'headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '-'],
      { cwd: WORKSPACE, env: env, stdio: [inFd, outFd, errFd] }
    );

    let done = false;
    const cleanup = () => {
      for (const f of [taskFile, outFile, errFile]) {
        try {
          rmSync(f, { force: true });
        } catch (e) {}
      }
    };

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
      cleanup();
      resolvePromise({ code: code, stdout: out, stderr: err });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {}
      finish(-1);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(-2);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === null ? -3 : code);
    });
  });
}

/**
 * 端到端：图片 → 会话 → 校验结果。
 * @returns {{ok,status,type,answers,errors,questionId,elapsedMs,exitCode}}
 */
export async function runVision(options) {
  const opts = options || {};
  const imageAbs = resolve(opts.imagePath);
  const questionId = String(opts.questionId || '');
  if (!existsSync(imageAbs)) return { ok: false, error: 'IMAGE_NOT_FOUND', questionId };
  if (!questionId) return { ok: false, error: 'MISSING_QUESTION_ID', questionId };

  const key = opts.apiKey || resolveApiKey({ keyFile: opts.keyFile, allowDevCredentials: opts.allowDevCredentials }).key;
  if (!key) return { ok: false, error: 'MISSING_CREDENTIAL', questionId };
  process.env.DEEPSEEK_API_KEY = key;

  const started = Date.now();
  const result = await runHeadless(buildTask(imageAbs, questionId), opts.timeoutMs || 180000);
  const elapsedMs = Date.now() - started;

  if (result.code !== 0) {
    // stderr 只保留尾部，且过滤掉可能出现的凭据片段
    const tail = String(result.stderr || '')
      .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***')
      .slice(-600);
    return { ok: false, error: 'SESSION_EXIT_' + result.code, questionId, elapsedMs, exitCode: result.code, stderr: tail };
  }

  try {
    const parsed = extractJson(result.stdout);
    const check = validateResult(parsed, questionId, opts.allowedLetters || []);
    return {
      ok: check.ok,
      status: check.status,
      type: check.type,
      answers: check.answers,
      errors: check.errors,
      questionId: questionId,
      elapsedMs: elapsedMs,
      exitCode: result.code,
    };
  } catch (e) {
    return { ok: false, error: 'PARSE_FAILED: ' + e.message, questionId, elapsedMs, exitCode: result.code };
  }
}
