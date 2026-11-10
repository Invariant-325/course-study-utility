// 代理冒烟测试：node tests/proxy-smoke.mjs
// 用假 Key 启动本地代理，只验证安全边界（token / Origin / 结构校验），
// 不发起真实上游请求。
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18787;
const TOKEN = 'test-token-123';

const child = spawn(process.execPath, [join(ROOT, 'proxy', 'quiz-proxy.mjs')], {
  env: Object.assign({}, process.env, {
    QUIZ_API_KEY: 'sk-fake-for-smoke-test',
    QUIZ_PROXY_PORT: String(PORT),
    QUIZ_PROXY_TOKEN: TOKEN,
    QUIZ_BASE_URL: 'http://127.0.0.1:1/never-used',
  }),
  stdio: 'ignore',
});

const output = '';

const base = 'http://127.0.0.1:' + PORT;
const results = [];

function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail: detail || '' });
}

try {
  // 等端口就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch (e) {
      /* 还没起来 */
    }
    await delay(100);
  }
  check('代理启动', ready, output.slice(0, 200));

  if (ready) {
    const health = await fetch(base + '/health').then((r) => r.json());
    check('health 返回 ok', health.ok === true, JSON.stringify(health));

    // 无 token
    const noToken = await fetch(base + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    check('拒绝无 token', noToken.status === 403, 'status=' + noToken.status);

    // 错误 token
    const badToken = await fetch(base + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Quiz-Token': 'wrong' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    check('拒绝错误 token', badToken.status === 403, 'status=' + badToken.status);

    // 非法 Origin
    const badOrigin = await fetch(base + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Quiz-Token': TOKEN, Origin: 'https://evil.example.com' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    check('拒绝非法 Origin', badOrigin.status === 403, 'status=' + badOrigin.status);

    // 合法 Origin + 正确 token，但 messages 结构非法
    const badBody = await fetch(base + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Quiz-Token': TOKEN, Origin: 'https://mooc1.chaoxing.com' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'x'.repeat(9000) }] }),
    });
    check('拒绝超长 content', badBody.status === 400, 'status=' + badBody.status);

    // 合法请求但上游不可用 -> 502（证明校验通过后确实尝试转发）
    const upstreamDown = await fetch(base + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Quiz-Token': TOKEN, Origin: 'https://mooc1.chaoxing.com' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '题目：1+1=?' }] }),
    });
    check('合法结构会尝试转发（上游不可用 -> 502）', upstreamDown.status === 502, 'status=' + upstreamDown.status);
  }
} finally {
  child.kill();
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log('  ✔ ' + r.name);
  } else {
    console.log('  ✖ ' + r.name + '  ' + r.detail);
    failed++;
  }
}
console.log('');
console.log(failed === 0 ? '代理冒烟测试通过（' + results.length + ' 项）' : '代理冒烟测试失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
