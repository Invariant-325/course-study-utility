// ---------------------------------------------------------------------------
// harness.mjs —— 在 jsdom + vm 里加载 src 源码，供测试调用
// 不修改源码；只在末尾追加一行导出语句。
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const EXPORT_NAMES = [
  'Log',
  'Config',
  'SEL',
  'Dom',
  'CourseUrl',
  'CourseTree',
  'VideoCtl',
  'PauseClassifier',
  'QuizModel',
  'Llm',
  'QuizRunner',
  'ChapterQuizAdapter',
  'ChapterQuizRunner',
  'StateMachine',
  'Runner',
  'UI',
  'queryFirst',
  'queryAllAcross',
  'queryAllFirst',
];

/**
 * @param {string[]} files 源文件名（不含路径），按依赖顺序
 * @param {object} [options]
 * @param {string} [options.html] 初始页面 HTML
 */
export function loadEnv(files, options = {}) {
  const dom = new JSDOM(
    options.html || '<!doctype html><html><body></body></html>',
    {
      url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1',
      pretendToBeVisual: true,
    }
  );

  // jsdom 不做布局，getBoundingClientRect 全为 0；给个可用的默认值
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 10, width: 80, height: 24, right: 90, bottom: 34, x: 10, y: 10 };
  };

  // 油猴 API 缺席时的行为也一并覆盖：Config 会退化为 localStorage
  const context = {
    console,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RegExp,
    Set,
    Map,
    WeakMap,
    WeakSet,
    isFinite,
    NaN,
    undefined,
    MutationObserver: dom.window.MutationObserver,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
  };

  let code = '';
  for (const name of files) {
    code += readFileSync(join(SRC, name), 'utf8') + '\n';
  }
  code +=
    '\nglobalThis.__exports = {' +
    EXPORT_NAMES.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : undefined`).join(',') +
    '};\n';

  vm.createContext(context);
  vm.runInContext(code, context, { filename: files.join('+') });

  // 可选注入：模拟 Tampermonkey 的 GM_xmlhttpRequest（用于 LLM 客户端测试）
  if (options.gm && typeof options.gm === 'function') {
    context.GM_xmlhttpRequest = options.gm;
  }

  return { dom, window: dom.window, document: dom.window.document, exports: context.__exports, context };
}

// 构造一个"任务点"HTML 片段
export function jobHtml({ state = 'unfinished', type = 'video', title = '' } = {}) {
  const label =
    state === 'finished'
      ? '任务点已完成'
      : state === 'unfinished'
        ? '任务点未完成'
        : '';
  const cls = state === 'finished' ? 'ans-job ans-job-finished' : 'ans-job';
  const src =
    type === 'video'
      ? '/ananas/modules/video/index.html?x=1'
      : type === 'work'
        ? '/ananas/modules/work/index.html?x=1'
        : type === 'document'
          ? '/ananas/modules/pdf/index.html?x=1'
          : '';
  const labelAttr = label ? ` aria-label="${label}"` : '';
  const titleAttr = title ? ` title="${title}"` : '';
  return (
    `<div class="${cls}">` +
    `<span class="ans-job-icon"${labelAttr}${titleAttr}></span>` +
    `<div class="ans-attach-online"><iframe src="${src}"></iframe></div>` +
    `</div>`
  );
}

// 在某个 document 里创建 iframe 并写入内部 HTML（同源，jsdom 支持）
export function makeIframe(doc, innerHtml, src) {
  const iframe = doc.createElement('iframe');
  if (src) iframe.setAttribute('src', src);
  doc.body.appendChild(iframe);
  const innerDoc = iframe.contentDocument;
  innerDoc.open();
  innerDoc.write('<!doctype html><html><body>' + innerHtml + '</body></html>');
  innerDoc.close();
  return iframe;
}
