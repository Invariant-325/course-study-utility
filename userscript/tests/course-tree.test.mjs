import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv, jobHtml, makeIframe } from './harness.mjs';

const FILES = ['10-log.js', '30-selectors.js', '35-urls.js', '40-dom.js', '50-course-tree.js'];

function env(html) {
  const e = loadEnv(FILES, { html: '<!doctype html><html><body>' + (html || '') + '</body></html>' });
  return e;
}

test('完成态：aria-label 判定未完成/已完成', () => {
  const { exports, document } = env(
    jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'finished' })
  );
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].state, 'unfinished');
  assert.equal(jobs[0].stateBy, 'label');
  assert.equal(jobs[1].state, 'finished');
});

test('完成态：容器 class ans-job-finished 优先判定为已完成', () => {
  const { exports } = env(
    '<div class="ans-job ans-job-finished"><span class="ans-job-icon" aria-label="任务点未完成"></span></div>'
  );
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'finished');
  assert.equal(jobs[0].stateBy, 'class');
});

test('完成态：无任何标记时为 unknown，不被当作未完成', () => {
  const { exports } = env('<div class="ans-job"><iframe src="/ananas/modules/video/index.html"></iframe></div>');
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'unknown');
});

test('类型识别：iframe src 判定 video / work / document', () => {
  const { exports } = env(
    jobHtml({ state: 'unfinished', type: 'video' }) +
      jobHtml({ state: 'unfinished', type: 'work' }) +
      jobHtml({ state: 'unfinished', type: 'document' })
  );
  const jobs = exports.CourseTree.enumerate();
  // 跨 vm realm 的数组原型不同，用字符串比较避免 deepStrictEqual 误报
  assert.equal(
    jobs.map((j) => j.type).join(','),
    'video,work,document'
  );
});

test('跨 iframe：任务点在第二层文档里也能枚举到', () => {
  const { exports, document } = env('');
  makeIframe(document, jobHtml({ state: 'unfinished' }));
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'unfinished');
  assert.equal(jobs[0].depth, 1);
});

test('跨 iframe：三层嵌套也能到达（maxFrameDepth=3）', () => {
  const { exports, document } = env('');
  const outer = makeIframe(document, '');
  makeIframe(outer.contentDocument, jobHtml({ state: 'unfinished' }));
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].depth, 2);
});

test('目标选择：跳过已完成，选第一个未完成视频', () => {
  const { exports } = env(
    jobHtml({ state: 'finished' }) + jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' })
  );
  const jobs = exports.CourseTree.enumerate();
  const pick = exports.CourseTree.pickNextVideoTarget(jobs, null);
  assert.equal(pick.job.id, jobs[1].id);
});

test('目标选择：从当前节点之后继续，不会重复选自己', () => {
  const { exports } = env(
    jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' })
  );
  const jobs = exports.CourseTree.enumerate();
  const first = exports.CourseTree.pickNextVideoTarget(jobs, null).job;
  const second = exports.CourseTree.pickNextVideoTarget(jobs, first.id).job;
  const third = exports.CourseTree.pickNextVideoTarget(jobs, second.id).job;
  assert.equal(first.id, jobs[0].id);
  assert.equal(second.id, jobs[1].id);
  assert.equal(third.id, jobs[2].id);
  assert.notEqual(second.id, first.id);
});

test('回归：到达最后一节后返回 null，绝不回头重播', () => {
  const { exports } = env(
    jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' })
  );
  const jobs = exports.CourseTree.enumerate();
  const pick = exports.CourseTree.pickNextVideoTarget(jobs, jobs[1].id);
  assert.equal(pick.job, null, '末尾之后必须没有目标，避免重播死循环');
});

test('目标选择：unknown 状态不被自动当作目标', () => {
  const { exports } = env(
    '<div class="ans-job"><iframe src="/ananas/modules/video/index.html"></iframe></div>'
  );
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs[0].state, 'unknown');
  const pick = exports.CourseTree.pickNextVideoTarget(jobs, null);
  assert.equal(pick.job, null);
  assert.equal(pick.skipped.length, 1);
});

test('目录：识别条目与当前激活项', () => {
  const { exports } = env(
    '<div id="coursetree"><ul>' +
      '<li><div class="posCatalog_select posCatalog_active"><span class="posCatalog_name">第一节</span></div></li>' +
      '<li><div class="posCatalog_select"><span class="posCatalog_name">第二节</span></div></li>' +
      '</ul></div>'
  );
  const catalog = exports.CourseTree.catalogEntries();
  assert.equal(catalog.rootSelector, '#coursetree');
  assert.equal(catalog.items.length, 2);
});

test('目录：点击当前项的下一项', () => {
  const { exports, document } = env(
    '<div id="coursetree"><ul>' +
      '<li><div class="posCatalog_select posCatalog_active"><span class="posCatalog_name">第一节</span></div></li>' +
      '<li><div class="posCatalog_select"><span class="posCatalog_name">第二节</span></div></li>' +
      '</ul></div>'
  );
  let clickedText = null;
  const names = document.querySelectorAll('.posCatalog_name');
  names[1].addEventListener('click', () => {
    clickedText = names[1].textContent;
  });

  const outcome = exports.CourseTree.clickNextCatalogItem();
  assert.equal(outcome.ok, true);
  assert.equal(clickedText, '第二节');
});

test('目录：已是最后一节时明确失败而不是乱点', () => {
  const { exports } = env(
    '<div id="coursetree"><ul>' +
      '<li><div class="posCatalog_select posCatalog_active"><span class="posCatalog_name">唯一一节</span></div></li>' +
      '</ul></div>'
  );
  const outcome = exports.CourseTree.clickNextCatalogItem();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'last-item');
});

test('视频定位：任务点 iframe 内的 video 能被找到', () => {
  const { exports, document } = env(jobHtml({ state: 'unfinished' }));
  const jobs = exports.CourseTree.enumerate();
  const iframe = document.querySelector('.ans-job iframe');
  iframe.contentDocument.open();
  iframe.contentDocument.write('<!doctype html><html><body><video id="video_html5_api"></video></body></html>');
  iframe.contentDocument.close();

  const video = exports.CourseTree.findVideoInJob(jobs[0]);
  assert.ok(video, '应找到 video');
  assert.equal(video.id, 'video_html5_api');
});

test('视频定位：没有 video 时返回 null（不抛错）', () => {
  const { exports } = env(jobHtml({ state: 'unfinished', type: 'work' }));
  const jobs = exports.CourseTree.enumerate();
  assert.equal(exports.CourseTree.findVideoInJob(jobs[0]), null);
});

// ===== 以下是 2026-11-10 实机验证后新增的用例 =====

test('实测结构：.ans-attach-ct 是任务点容器（.ans-job 在新版不存在）', () => {
  const { exports, document } = env(
    '<div class="ans-attach-ct videoContainer">' +
      '<div class="ans-job-icon ans-job-video ans-job-icon-clear" aria-label="任务点未完成"></div>' +
      '<iframe class="ans-attach-online ans-insertvideo-online" src="/ananas/modules/video/index.html?v=1"></iframe>' +
      '</div>'
  );
  assert.equal(document.querySelectorAll('.ans-job').length, 0, '确认没有 .ans-job');
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'unfinished');
  assert.equal(jobs[0].stateLabel, '任务点未完成');
  assert.equal(jobs[0].type, 'video');
});

test('实测结构：icon 的父级是 .ans-attach-ct 时也能兜底识别', () => {
  const { exports } = env(
    '<div class="ans-attach-ct">' +
      '<div class="ans-job-icon" aria-label="任务点未完成"></div>' +
      '</div>'
  );
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'unfinished');
});

test('实测结构：目录层 "N个待完成任务点" 可解析', () => {
  const { exports } = env(
    '<div class="chapter_head">已完成任务点: 0/59</div>' +
      '<div id="coursetree"><ul>' +
      '<li><div class="posCatalog_select firstLayer">1 正确理解和把握习近平党建思想</div></li>' +
      '<li><div class="posCatalog_select posCatalog_active">1.1 大党之治 2个待完成任务点2</div></li>' +
      '<li><div class="posCatalog_select">1.2 核心要义 11个待完成任务点11</div></li>' +
      '</ul></div>'
  );
  const progress = exports.CourseTree.catalogProgress();
  assert.equal(progress.ok, true);
  assert.equal(progress.total, 2, '只统计非 firstLayer 的节');
  assert.equal(progress.pending, 13, '2 + 11');
  assert.equal(progress.unknown, 0);
  assert.equal(progress.items.filter((i) => i.active).length, 1);
});

test('实测结构：头部汇总 "已完成任务点: 0/59"', () => {
  const { exports } = env('<div class="chapter_head"> 已完成任务点: 0/59 </div>');
  const summary = exports.CourseTree.readCatalogSummary();
  assert.equal(summary.done, 0);
  assert.equal(summary.total, 59);
});

test('实测结构：节内标签识别 视频 / 章节测验', () => {
  const { exports } = env(
    '<div class="prev_white">1 课程视频</div>' +
      '<div class="prev_white">2 章节测验</div>'
  );
  const tabs = exports.CourseTree.readTaskTabs();
  assert.equal(tabs.video, true);
  assert.equal(tabs.quiz, true);
});

test('实测结构：无待完成文本时 pending 记为 unknown 而不是 0', () => {
  const { exports } = env(
    '<div id="coursetree"><ul>' +
      '<li><div class="posCatalog_select">1.1 没有计数的节</div></li>' +
      '</ul></div>'
  );
  const progress = exports.CourseTree.catalogProgress();
  assert.equal(progress.total, 1);
  assert.equal(progress.pending, 0);
  assert.equal(progress.unknown, 1, '无法解析必须记 unknown，不能当成已完成');
});

// ===== P0-3 / P0-4 相关回归 =====

test('嵌套容器只统计一次（.ans-job 包着 .ans-attach-ct）', () => {
  const { exports } = env(
    '<div class="ans-job">' +
      '<span class="ans-job-icon" aria-label="任务点未完成"></span>' +
      '<div class="ans-attach-ct videoContainer">' +
      '<iframe src="/ananas/modules/video/index.html"></iframe>' +
      '</div>' +
      '</div>'
  );
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1, '一个任务点不能被统计成两个');
  assert.equal(jobs[0].state, 'unfinished');
});

test('完成标记在祖先容器上时，向上查找仍能识别', () => {
  const { exports } = env(
    '<div class="ans-job-finished">' +
      '<div class="ans-attach-ct">' +
      '<span class="ans-job-icon"></span>' +
      '<iframe src="/ananas/modules/video/index.html"></iframe>' +
      '</div>' +
      '</div>'
  );
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'finished', '外层容器的完成标记必须被采纳');
});

test('每个任务点都有 stableKey，且不依赖标题', () => {
  const { exports } = env(jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' }));
  const jobs = exports.CourseTree.enumerate();
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.equal(typeof job.stableKey, 'string');
    assert.ok(job.stableKey.length > 0);
    assert.ok(job.stableKey.indexOf(job.title) === -1 || job.title === '');
  }
  assert.notEqual(jobs[0].stableKey, jobs[1].stableKey, '同页不同任务点 key 必须不同');
});

test('pickNextVideoTarget：excludeKeys 中的任务不得被选中（防止重复播放）', () => {
  const { exports } = env(
    jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' }) + jobHtml({ state: 'unfinished' })
  );
  const jobs = exports.CourseTree.enumerate();
  const exclude = new Set([jobs[1].stableKey]);

  const pick = exports.CourseTree.pickNextVideoTarget(jobs, jobs[0].id, { excludeKeys: exclude });
  assert.equal(pick.job.id, jobs[2].id, '应跳过被排除的任务');
  assert.ok(
    pick.skipped.some((j) => j.stableKey === jobs[1].stableKey),
    '被排除的任务应出现在 skipped 里'
  );
});

test('pickNextVideoTarget：全部被排除时返回 null，不回头重播', () => {
  const { exports } = env(jobHtml({ state: 'unfinished' }));
  const jobs = exports.CourseTree.enumerate();
  const exclude = new Set([jobs[0].stableKey]);
  const pick = exports.CourseTree.pickNextVideoTarget(jobs, null, { excludeKeys: exclude });
  assert.equal(pick.job, null);
});

test('enumerateDetail 显式返回 inaccessible 列表（不静默丢弃）', () => {
  const { exports } = env(jobHtml({ state: 'unfinished' }));
  const detail = exports.CourseTree.enumerateDetail();
  assert.ok(Array.isArray(detail.documents));
  assert.ok(Array.isArray(detail.inaccessible), 'inaccessible 必须是数组');
  assert.equal(detail.jobs.length, 1);
  assert.equal(detail.stats.jobCount, 1);
  assert.equal(detail.stats.unfinished, 1);
});
