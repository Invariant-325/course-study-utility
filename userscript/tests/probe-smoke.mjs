// ---------------------------------------------------------------------------
// probe-smoke.mjs —— 探针冒烟测试（独立运行，不计入常规测试套件）
// 目的：在真实页面使用之前，确认探针能产出结构合法的 JSON。
//   node tests/probe-smoke.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'probe', 'chaoxing-probe.user.js');

const HTML = `<!doctype html><html><body>
  <div class="ans-job">
    <span class="ans-job-icon" aria-label="任务点未完成"></span>
    <iframe src="/ananas/modules/video/index.html"></iframe>
  </div>
  <div class="ans-job ans-job-finished">
    <span class="ans-job-icon" aria-label="任务点已完成"></span>
  </div>
  <div class="ans-job">
    <span class="ans-job-icon"></span>
    <iframe src="/ananas/modules/work/index.html"></iframe>
  </div>
  <div id="coursetree"><ul>
    <li><div class="posCatalog_select posCatalog_active"><span class="posCatalog_name">第一节</span></div></li>
    <li><div class="posCatalog_select"><span class="posCatalog_name">第二节</span></div></li>
  </ul></div>
  <iframe id="panView" class="ans-attach-online" src="https://pan-yz.chaoxing.com/mooc-ans/screen/file/x"></iframe>
</body></html>`;

const dom = new JSDOM(HTML, {
  url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
dom.window.Element.prototype.getBoundingClientRect = function () {
  return { left: 10, top: 10, width: 640, height: 360, right: 650, bottom: 370, x: 10, y: 10 };
};

const captured = [];
dom.window.console = {
  log: (...args) => captured.push(args.join(' ')),
  warn: (...args) => captured.push(args.join(' ')),
  error: (...args) => captured.push('ERR ' + args.join(' ')),
};

let thrown = null;
try {
  dom.window.eval(readFileSync(PROBE, 'utf8'));
} catch (e) {
  thrown = e;
}

function fail(message) {
  console.error('✖ ' + message);
  process.exit(1);
}

if (thrown) fail('探针注入即抛错：' + (thrown && thrown.message));

// 等采样与按钮挂载（探针最后一次采样 +400ms）
const WAIT_MS = 6000;
console.log('等待探针采样与挂载面板（' + WAIT_MS + 'ms）…');

setTimeout(() => {
  const host = dom.window.document.getElementById('cx-probe-host');
  if (!host) fail('探针面板未挂载');
  const shadow = host.shadowRoot;
  if (!shadow) fail('探针面板缺少 shadowRoot');
  const button = shadow.querySelector('button');
  if (!button) fail('探针面板缺少导出按钮');

  captured.length = 0;
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  const entry = captured.find((line) => line.indexOf('[学习通探针] 导出数据') !== -1);
  if (!entry) fail('点击后没有输出导出数据；捕获内容：' + JSON.stringify(captured.slice(0, 3)));

  const jsonText = entry.slice(entry.indexOf('{'));
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    fail('导出的 JSON 无法解析：' + e.message);
  }

  const problems = [];
  if (!data.summary) problems.push('缺少 summary');
  if (!Array.isArray(data.frames)) problems.push('缺少 frames 数组');
  if (!data.topReport) problems.push('缺少 topReport');
  if (data.summary && data.summary.totalJobs !== 3) {
    problems.push('totalJobs 期望 3，实际 ' + data.summary.totalJobs);
  }
  if (data.summary && data.summary.jobStates.withUnfinishedLabel !== 1) {
    problems.push('未完成标记计数错误：' + JSON.stringify(data.summary.jobStates));
  }
  // 第二个任务点同时带 finished class 与"已完成"label，非互斥统计下两边各计 1
  if (data.summary && data.summary.jobStates.withFinishedLabel !== 1) {
    problems.push('已完成 label 计数错误：' + JSON.stringify(data.summary.jobStates));
  }
  if (data.summary && data.summary.jobStates.withFinishedClass !== 1) {
    problems.push('finishedClass 计数错误：' + JSON.stringify(data.summary.jobStates));
  }
  if (data.summary && data.summary.jobStates.noMarker !== 1) {
    problems.push('无标记任务点计数错误：' + JSON.stringify(data.summary.jobStates));
  }
  if (data.summary && data.summary.catalogLeaf !== 2) {
    problems.push('catalogLeaf 期望 2，实际 ' + data.summary.catalogLeaf);
  }
  if (data.topReport && !Array.isArray(data.topReport.jobs)) problems.push('topReport.jobs 非数组');
  if (data.topReport && data.topReport.videos === undefined) problems.push('topReport 缺少 videos');

  if (problems.length) {
    fail('探针输出不符合预期：\n - ' + problems.join('\n - '));
  }

  // jsdom 不实现真实的跨域隔离（跨域 iframe 也会给出空的同源文档），
  // 因此 crossOriginCount 只能在真实浏览器里验证，这里只做提示。
  console.log('✔ 探针冒烟测试通过');
  console.log('  summary = ' + JSON.stringify(data.summary, null, 2));
  console.log(
    '  注意：crossOriginCount=' + data.summary.crossOriginCount +
      '，该项在 jsdom 中无法验证，需真实页面确认。'
  );
  dom.window.close();
  process.exit(0);
}, WAIT_MS);
