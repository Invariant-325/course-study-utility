// ---------------------------------------------------------------------------
// selectors.js —— 全部 DOM 选择器集中管理
//
// 组织方式：语义名 -> 候选数组。查找时按顺序尝试，第一个命中的生效。
// 所有条目均标注来源与验证状态；未经真实页面验证的条目一律标记 UNVERIFIED。
//
// 来源说明：
//   [GF572981]  = Greasy Fork 572981（MIT），任务点 aria-label 判定
//   [ZHU]       = zhu-hailin/chaoxing-ai-assistant（MIT），弹题选择器常量
//   [CL]        = chaolucky18/xuexitongScript（无许可证，仅作事实参考，不复制代码）
//   [DR]        = DaRin1403/xuexitong-autostudy（MIT），iframe 路径形态
// ---------------------------------------------------------------------------
const SEL = {
  // ===== 课程内容 iframe（顶层页面里承载卡片的 iframe）=====
  // [CL] 用 #iframe；[DR] 同
  courseFrame: ['iframe#iframe', '#iframe'],
  // 卡片容器可能在第二层 iframe 内，任务点直接挂在任一可达文档里
  maxFrameDepth: 3,

  // ===== 任务点 =====
  // [实测 2026-11-10 学习页 mooc1/mycourse/studentstudy]
  //   .ans-job       不存在
  //   .ans-attach-ct 实际容器（附加类 .videoContainer）
  //   父级链：div.ans-job-icon < div.ans-attach-ct.videoContainer < p.editor-iframe < div.ans-cc
  // .ans-job 保留用于旧版页面兼容。
  jobContainer: ['.ans-attach-ct', '.ans-job', '[data-isjob="true"]', '.ans-job-finished'],
  jobIcon: ['.ans-job-icon'],
  jobFinishedClass: 'ans-job-finished',
  // [实测] aria-label="任务点未完成" 与旧版一致，可原样使用
  iconLabelUnfinished: ['任务点未完成', '未完成'],
  iconLabelFinished: ['任务点已完成', '已完成'],
  jobInnerIframe: ['iframe'],
  // [实测] 播放器 iframe 的类名
  jobVideoFrame: '.ans-attach-online, .ans-insertvideo-online',

  // ===== 播放器 =====
  // [DR] videojs 初始化在 #video_html5_api；[CL] 同；vjs-tech 为 video.js 默认类名
  // [实测] id="video_html5_api" class="vjs-tech" 两者同时存在
  videoElement: ['#video_html5_api', 'video.vjs-tech', 'video'],

  // ===== 课程目录 =====
  // [实测] #coursetree ×1、.posCatalog_level ×9、.posCatalog_select ×40 同时存在
  catalogRoot: ['#coursetree', '.posCatalog_level'],
  // [实测] 只保留 .posCatalog_select；原先的 'li' 会误匹配外层 li，必须移除
  catalogItem: ['.posCatalog_select'],
  catalogActiveClass: 'posCatalog_active',
  catalogNameNode: ['.catalog_name', '.posCatalog_name', 'span[title]'],
  // 章（一级）与节（二级）的区分：带 firstLayer 类的是一级
  firstLayerClass: 'firstLayer',

  // ===== 目录层完成度（实测新增）=====
  // [实测] 每节文本形如 "1.1 大党之治：… 2个待完成任务点2"
  // 这是不进节就能判断完成度的最佳信号。
  catalogPendingPattern: /(\d+)\s*个待完成任务点/,
  catalogPendingWord: '待完成任务点',
  // 头部汇总，形如 "已完成任务点: 0/59"
  catalogSummaryText: /已完成任务点[:：]?\s*(\d+)\s*\/\s*(\d+)/,

  // ===== 节内任务类型标签（实测新增）=====
  // [实测] 页面标签为 "1 课程视频" / "2 章节测验"
  // 每节"N个待完成任务点"通常是 1 视频 + 1 测验，不能把测验当视频处理。
  // 注意：不要用 [class*="tab"] 这种宽泛选择器——实机验证时它误匹配到了
  // 页面里无关的隐藏文本（"请输入验证码…"），导致任务类型判断被污染。
  taskTabVideo: /课程视频|视频/,
  taskTabQuiz: /章节测验|测验|作业/,
  taskTabSelector: '.prev_white, .prev_title',

  // ===== 页面级"下一节"按钮 =====
  // [GF572981][DR] 均使用这两个
  nextSectionButton: ['#prevNextFocusNext', '.nextChapter'],
  // 结束弹窗里的"下一节"
  popContainer: ['.popDiv'],

  // ===== 弹题（阶段 D，选择器来自 zhu-hailin MIT 常量 + 通用候选）=====
  // 注意：真实弹题 DOM 尚未实机采集，以下均为候选，需要靠诊断收敛。
  quizRoot: ['.ans-videoquiz', '[data-video-quiz-root]'],
  quizSubmitButton: ['#videoquiz-submit', '[data-video-quiz-submit]'],
  quizContinueButton: ['#videoquiz-continue', '.ans-videoquiz-continue'],
  quizFeedback: [
    '[data-video-quiz-result]',
    '.videoquiz-result',
    '.videoquiz-feedback',
    '.answer-feedback',
  ],
  // 题干候选（按优先级）
  quizStem: [
    '.tkItem_title',
    'legend',
    '.question-title',
    '.quiz-title',
    '.subject-title',
    '[class*="stem"]',
    '[class*="title"]',
  ],
  // 选项容器候选
  quizOptionBox: ['li', 'label', '.option-item', '[class*="option"]', '[class*="item"]'],
  // 判分/对错提示（用于确认是否已作答成功）
  quizRight: ['.rightInfo', '[class*="right"]', '.dui', '.correct'],
  quizWrong: ['.spanNot', '.spanNotBack', '[class*="wrong"]', '.cuo'],
  // 选项字母前缀，如 "A." "B、" "C：" "D)"
  quizLetterPattern: /^([A-H])[.、．:：)）]\s*/,
  // 判断题选项词
  quizJudgeWords: /^(正确|错误|对|错|是|否|true|false|√|×)$/i,

  // ===== iframe src 类型判定 =====
  // [DR] /ananas/modules/<type>/
  jobTypePatterns: [
    { type: 'video', re: /\/ananas\/modules\/video\//i },
    { type: 'audio', re: /\/ananas\/modules\/audio\//i },
    { type: 'document', re: /\/ananas\/modules\/(doc|pdf|ppt)\//i },
    { type: 'image', re: /\/ananas\/modules\/(img|image|picture)\//i },
    { type: 'work', re: /\/ananas\/modules\/work\//i },
  ],
};

// 查找策略：对同一文档 + 候选数组，返回第一个命中的元素
function queryFirst(root, candidates) {
  if (!root || !root.querySelector) return null;
  for (const selector of candidates) {
    try {
      const found = root.querySelector(selector);
      if (found) return found;
    } catch (e) {
      /* 非法选择器不应中断流程 */
    }
  }
  return null;
}

// 返回第一个命中的选择器名，便于日志定位是哪条规则生效
function queryFirstWithSelector(root, candidates) {
  if (!root || !root.querySelector) return null;
  for (const selector of candidates) {
    try {
      const found = root.querySelector(selector);
      if (found) return { selector, element: found };
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

function queryAllAcross(root, candidates) {
  const seen = new Set();
  const out = [];
  for (const selector of candidates) {
    try {
      for (const el of root.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    } catch (e) {
      /* ignore */
    }
  }
  return out;
}

// 互斥候选专用：按顺序尝试，返回「第一个能匹配到元素的选择器」的全部结果。
// 不能像 queryAllAcross 那样合并，否则 ['.posCatalog_select', 'li'] 会把同一个
// 节点匹配两次，导致目录条目数量翻倍、索引错位。
function queryAllFirst(root, candidates) {
  if (!root || !root.querySelectorAll) return [];
  for (const selector of candidates) {
    try {
      const found = root.querySelectorAll(selector);
      if (found && found.length) return Array.prototype.slice.call(found);
    } catch (e) {
      /* ignore */
    }
  }
  return [];
}
