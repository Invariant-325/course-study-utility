// ---------------------------------------------------------------------------
// urls.js —— 课程页面判定与身份提取（P0-1）
//
// 真实页面证据（2026-11-10 实测）：
//   课程主页 https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu
//     顶层 document.domain 被平台设为 "chaoxing.com"，
//     而 #frame_content-zj 未做同样设置 -> 访问 contentDocument 抛 SecurityError。
//     该页只有导航壳子，课程目录与任务点全在不可读的子框架里，
//     **不能**作为自动连播的运行入口。
//   学习页 https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=...&courseId=...
//     三层同源可读，是唯一可工作的入口。
//
// 本模块是唯一的 URL 判定来源，main 与 runner 都必须调用它。
// ---------------------------------------------------------------------------
const CourseUrl = (function () {
  // 可注入并可运行的真实学习页
  const STUDY_PATTERNS = [
    /\/mycourse\/studentstudy(?:[/?#]|$)/i,
    // knowledge/cards 实测是学习页的内层 iframe（顶层不会出现）；
    // 保留它是为了容错：若将来放开 @noframes 注入子框架，这里仍是合法工作面。
    /\/mooc-ans\/knowledge\/cards(?:[/?#]|$)/i,
  ];

  // 明确排除：课程主页壳子与它的子页
  const EXCLUDED_PATTERNS = [
    /\/mooc2-ans\/mycourse\/stu(?:[/?#]|$)/i,
    /\/mooc2-ans\/mycourse\/studentcourse(?:[/?#]|$)/i,
    /\/mooc2-ans\/mycourse\//i,
    /\/mooc2-ans\//i,
  ];

  function test(patterns, url) {
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(url)) return true;
    }
    return false;
  }

  function isStudyPage(url) {
    const target = String(url || '');
    if (!target) return false;
    // 先排除，再匹配：排除优先，避免未来新增模式时误中课程主页
    if (test(EXCLUDED_PATTERNS, target)) return false;
    return test(STUDY_PATTERNS, target);
  }

  function isExcluded(url) {
    return test(EXCLUDED_PATTERNS, String(url || ''));
  }

  function searchParams(url) {
    try {
      return new URL(String(url || location.href), location.href).searchParams;
    } catch (e) {
      return null;
    }
  }

  function pick(params, names) {
    if (!params) return '';
    for (let i = 0; i < names.length; i++) {
      const value = params.get(names[i]);
      if (value) return String(value);
    }
    return '';
  }

  // 课程身份：用于 pendingConfirm 的稳定标识，不用标题
  function identity(url) {
    const params = searchParams(url);
    return {
      courseId: pick(params, ['courseId', 'courseid']),
      chapterId: pick(params, ['chapterId', 'chapterid', 'knowledgeId', 'knowledgeid']),
      clazzId: pick(params, ['clazzid', 'clazzId']),
    };
  }

  // 稳定 key：courseId/chapterId/type#index
  function jobKey(job, url) {
    const id = identity(url);
    if (!job) return '';
    const type = job.type || 'unknown';
    const index = job.indexInDoc === undefined ? '' : job.indexInDoc;
    return [id.courseId || '?', id.chapterId || '?', type, '#' + index].join('/');
  }

  // 页面类型描述，用于诊断
  function describe(url) {
    const target = String(url || location.href);
    if (isExcluded(target)) return 'excluded-course-home';
    if (isStudyPage(target)) return 'study-page';
    return 'other';
  }

  return {
    isStudyPage,
    isExcluded,
    identity,
    jobKey,
    describe,
    STUDY_PATTERNS,
    EXCLUDED_PATTERNS,
  };
})();
