import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const { exports } = loadEnv(['10-log.js', '35-urls.js']);
const CourseUrl = exports.CourseUrl;

// 回归用例 #10：当前课程主页不得匹配自动化启动条件
test('课程主页 mooc2-ans/stu 不得被当作学习页', () => {
  const home = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=267253952&clazzid=155119646&cpi=100000001&enc=6a54&t=1794&pageHeader=1&v=2';
  assert.equal(CourseUrl.isStudyPage(home), false, '课程主页必须被排除');
  assert.equal(CourseUrl.isExcluded(home), true);
  assert.equal(CourseUrl.describe(home), 'excluded-course-home');
});

test('课程主页的 studentcourse 子页也不得被当作学习页', () => {
  const sub = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=1&clazzid=2';
  assert.equal(CourseUrl.isStudyPage(sub), false);
});

test('确认可工作的学习页必须匹配', () => {
  const study = 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1248884878&courseId=267253952&clazzid=155119646';
  assert.equal(CourseUrl.isStudyPage(study), true);
  assert.equal(CourseUrl.describe(study), 'study-page');
});

test('knowledge/cards 保留为合法入口（学习页内层帧）', () => {
  const cards = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&courseid=2&knowledgeid=3';
  assert.equal(CourseUrl.isStudyPage(cards), true, 'knowledge/cards 不应被误删');
});

test('无关页面不匹配', () => {
  assert.equal(CourseUrl.isStudyPage('https://mooc1.chaoxing.com/'), false);
  assert.equal(CourseUrl.isStudyPage('https://i.chaoxing.com/base'), false);
  assert.equal(CourseUrl.isStudyPage(''), false);
  assert.equal(CourseUrl.isStudyPage('not a url'), false);
});

test('identity 提取课程/章节/班级标识', () => {
  const id = CourseUrl.identity(
    'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1248884878&courseId=267253952&clazzid=155119646&enc=secret'
  );
  assert.equal(id.courseId, '267253952');
  assert.equal(id.chapterId, '1248884878');
  assert.equal(id.clazzId, '155119646');
});

test('jobKey 使用稳定标识且不含标题', () => {
  const key = CourseUrl.jobKey(
    { type: 'video', indexInDoc: 0, title: '1.1 大党之治' },
    'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=11&courseId=22'
  );
  assert.equal(key, '22/11/video/#0');
  assert.equal(key.indexOf('大党之治'), -1, '不得依赖标题');
});

test('jobKey 对不同章节任务产生不同 key', () => {
  const a = CourseUrl.jobKey({ type: 'video', indexInDoc: 0 }, 'https://x.chaoxing.com/mycourse/studentstudy?chapterId=100&courseId=1');
  const b = CourseUrl.jobKey({ type: 'video', indexInDoc: 0 }, 'https://x.chaoxing.com/mycourse/studentstudy?chapterId=200&courseId=1');
  assert.notEqual(a, b);
});
