// ==UserScript==
// @name         学习通页面结构探针（只读诊断 · 可复核存档）
// @namespace    local.chaoxing.probe
// @version      0.2.0
// @description  只读导出 iframe 结构 / 任务点完成态 / 目录结构 / 选择器命中，输出脱敏 JSON 以便复核。不点击、不播放、不修改页面。
// @author       local
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://*.xuexitong.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// 设计说明
// ---------------------------------------------------------------------------
// 1. 故意不声明 @noframes：本探针需要在每个匹配的 frame 内运行，
//    才能分别回答"这个 frame 里有什么"与"我能否读到这个 frame"。
// 2. 零 GM 权限：子 frame 用 postMessage 把自采数据上报给 top，顶层汇总。
// 3. 全只读：不 dispatch 事件、不改属性、不调用 play()/click()。
//    唯一新增的 DOM 是右下角一个 Shadow DOM 按钮。
// 4. 脱敏：URL 去掉 enc / cpi / t / stuenc / ut / fid 等会话参数；
//    不读 Cookie、不读 localStorage、不记录账号信息。
// 5. 跨域原因不止 document.domain 一种：同时记录 sandbox / allow /
//    referrerPolicy / csp 等可观测属性，避免过早下结论。
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const PROBE_VERSION = '0.2.0';
  const CHANNEL = 'cx-probe-v1';
  const MAX_DEPTH = 12;
  const SAMPLE_AT = [1200, 5000];

  // 仅保留用于定位、不含会话凭证的参数
  const SAFE_PARAMS = ['courseId', 'courseid', 'chapterId', 'chapterid', 'clazzid', 'knowledgeid', 'knowledgeId'];

  const isTop = (function () {
    try {
      return window.top === window.self;
    } catch (e) {
      return false;
    }
  })();

  function text(el, max) {
    try {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length > (max || 60) ? t.slice(0, max || 60) + '…' : t;
    } catch (e) {
      return '';
    }
  }

  // 脱敏 URL：协议+主机+路径+白名单参数
  function safeUrl(raw, base) {
    if (!raw) return '';
    try {
      const u = new URL(String(raw), base || location.href);
      const kept = [];
      for (const key of SAFE_PARAMS) {
        const value = u.searchParams.get(key);
        if (value) kept.push(key + '=' + value);
      }
      const path = u.pathname.length > 120 ? u.pathname.slice(0, 120) + '…' : u.pathname;
      return u.origin + path + (kept.length ? '?' + kept.join('&') : '');
    } catch (e) {
      return '(unparsable)';
    }
  }

  function count(doc, selector) {
    try {
      return doc.querySelectorAll(selector).length;
    } catch (e) {
      return -1;
    }
  }

  function has(doc, selector) {
    try {
      return !!doc.querySelector(selector);
    } catch (e) {
      return false;
    }
  }

  // ---------- 任务点 ----------
  function collectJobs(doc) {
    const containers = [];
    const seen = new Set();
    // 实测优先：.ans-attach-ct；.ans-job 保留兼容
    for (const selector of ['.ans-attach-ct', '.ans-job']) {
      let list = [];
      try {
        list = Array.prototype.slice.call(doc.querySelectorAll(selector));
      } catch (e) {
        list = [];
      }
      for (const el of list) {
        if (!seen.has(el)) {
          seen.add(el);
          containers.push(el);
        }
      }
    }
    // 兜底：用 icon 的父级
    if (!containers.length) {
      try {
        for (const icon of doc.querySelectorAll('.ans-job-icon')) {
          const parent = icon.closest('.ans-attach-ct, .ans-job') || icon.parentElement;
          if (parent && !seen.has(parent)) {
            seen.add(parent);
            containers.push(parent);
          }
        }
      } catch (e) {
        /* ignore */
      }
    }

    // 去掉"内部还包含另一个容器"的外层，避免重复统计
    const leaves = containers.filter(function (el) {
      for (const other of containers) {
        if (other === el) continue;
        try {
          if (el.contains(other)) return false;
        } catch (e) {
          /* ignore */
        }
      }
      return true;
    });

    return leaves.slice(0, 80).map(function (el, index) {
      const icon = (function () {
        try {
          return el.querySelector('.ans-job-icon');
        } catch (e) {
          return null;
        }
      })();
      let frames = [];
      try {
        frames = Array.prototype.slice.call(el.querySelectorAll('iframe'));
      } catch (e) {
        frames = [];
      }
      let hasVideo = false;
      try {
        hasVideo = !!el.querySelector('video');
      } catch (e) {
        /* ignore */
      }
      return {
        index: index,
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        classes: String(el.className || '').slice(0, 140),
        hasFinishedClass: (function () {
          try {
            return el.classList.contains('ans-job-finished');
          } catch (e) {
            return false;
          }
        })(),
        iconClasses: icon ? String(icon.className || '').slice(0, 120) : null,
        iconLabel: icon ? icon.getAttribute('aria-label') || '' : null,
        iconTitle: icon ? icon.getAttribute('title') || '' : null,
        iframeSrcs: frames.map(function (f) {
          return safeUrl(f.getAttribute('src'), doc.baseURI);
        }),
        iframeClasses: frames.map(function (f) {
          return String(f.className || '').slice(0, 90);
        }),
        hasVideo: hasVideo,
        text: text(el, 50),
      };
    });
  }

  function collectVideos(doc) {
    let list = [];
    try {
      list = Array.prototype.slice.call(doc.querySelectorAll('video'));
    } catch (e) {
      list = [];
    }
    return list.slice(0, 20).map(function (v) {
      return {
        id: v.id || '',
        className: String(v.className || '').slice(0, 100),
        src: safeUrl(v.currentSrc || v.src || '', doc.baseURI),
        duration: Number(v.duration) || 0,
        currentTime: Number(v.currentTime) || 0,
        paused: !!v.paused,
        ended: !!v.ended,
        playbackRate: Number(v.playbackRate) || 1,
        readyState: Number(v.readyState) || 0,
        networkState: Number(v.networkState) || 0,
      };
    });
  }

  // ---------- 目录 ----------
  function collectCatalog(doc) {
    const result = { root: null, itemSelector: null, leafCount: 0, firstLayerCount: 0, pendingSum: 0, pendingUnknown: 0, items: [] };
    const roots = ['#coursetree', '.posCatalog_level'];
    for (const selector of roots) {
      let root = null;
      try {
        root = doc.querySelector(selector);
      } catch (e) {
        continue;
      }
      if (!root) continue;
      result.root = selector;

      let items = [];
      for (const itemSelector of ['.posCatalog_select', '.chapter_item']) {
        try {
          const found = root.querySelectorAll(itemSelector);
          if (found && found.length) {
            items = Array.prototype.slice.call(found);
            result.itemSelector = itemSelector;
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }

      const leaves = [];
      for (const el of items) {
        let firstLayer = false;
        try {
          firstLayer = el.classList.contains('firstLayer');
        } catch (e) {
          /* ignore */
        }
        if (firstLayer) {
          result.firstLayerCount++;
          continue;
        }
        const t = text(el, 60);
        const match = t.match(/(\d+)\s*个待完成任务点/);
        const pending = match ? Number(match[1]) : null;
        if (pending === null) result.pendingUnknown++;
        else result.pendingSum += pending;
        leaves.push({
          text: t.slice(0, 46),
          classes: String(el.className || '').slice(0, 90),
          active: (function () {
            try {
              return el.classList.contains('posCatalog_active') || !!el.querySelector('.posCatalog_active');
            } catch (e) {
              return false;
            }
          })(),
          pending: pending,
        });
      }
      result.leafCount = leaves.length;
      result.items = leaves.slice(0, 60);
      break;
    }
    return result;
  }

  // ---------- iframe ----------
  function collectFrames(doc) {
    let frames = [];
    try {
      frames = Array.prototype.slice.call(doc.querySelectorAll('iframe'));
    } catch (e) {
      frames = [];
    }
    return frames.slice(0, 50).map(function (f) {
      let sameOriginDoc = false;
      let errorName = '';
      try {
        sameOriginDoc = !!f.contentDocument;
      } catch (e) {
        sameOriginDoc = false;
        errorName = (e && e.name) || 'Error';
      }
      let visible = null;
      try {
        const rect = f.getBoundingClientRect();
        visible = rect.width > 0 && rect.height > 0;
      } catch (e) {
        visible = null;
      }
      // 跨域可能来自多种原因，把可观测属性都记下来，不预设结论
      return {
        id: f.id || '',
        className: String(f.className || '').slice(0, 100),
        src: safeUrl(f.getAttribute('src'), doc.baseURI),
        sameOriginDoc: sameOriginDoc,
        errorName: errorName,
        sandbox: f.getAttribute('sandbox'),
        allow: f.getAttribute('allow'),
        referrerPolicy: f.getAttribute('referrerpolicy'),
        credentialless: f.hasAttribute('credentialless'),
        visible: visible,
      };
    });
  }

  function collectLocal(seq) {
    const doc = document;
    const jobs = collectJobs(doc);
    return {
      channel: CHANNEL,
      kind: 'frame-report',
      seq: seq,
      probeVersion: PROBE_VERSION,
      at: new Date().toISOString(),
      url: safeUrl(location.href),
      origin: location.origin,
      isTop: isTop,
      frameName: (function () {
        try {
          return window.name || '';
        } catch (e) {
          return '';
        }
      })(),
      readyState: doc.readyState,
      // document.domain 被改写是已知的跨域诱因之一，单独记录
      documentDomain: (function () {
        try {
          return doc.domain || '';
        } catch (e) {
          return '';
        }
      })(),
      visibility: {
        state: doc.visibilityState,
        hidden: !!doc.hidden,
        hasFocus: (function () {
          try {
            return doc.hasFocus();
          } catch (e) {
            return null;
          }
        })(),
      },
      counts: {
        iframes: count(doc, 'iframe'),
        videos: count(doc, 'video'),
        attachCt: count(doc, '.ans-attach-ct'),
        ansJob: count(doc, '.ans-job'),
        ansJobIcon: count(doc, '.ans-job-icon'),
        ansJobFinished: count(doc, '.ans-job-finished'),
        posCatalogSelect: count(doc, '.posCatalog_select'),
        coursestree: count(doc, '#coursetree'),
        ansVideoquiz: count(doc, '.ans-videoquiz'),
        dataVideoQuizRoot: count(doc, '[data-video-quiz-root]'),
        videoquizSubmit: count(doc, '#videoquiz-submit'),
      },
      selectors: {
        mainidIframe: has(doc, '#mainid #iframe'),
        plainIframe: has(doc, '#iframe'),
        prevNextFocusNext: has(doc, '#prevNextFocusNext'),
        nextChapter: has(doc, '.nextChapter'),
        videoHtml5Api: has(doc, '#video_html5_api'),
        vjsTech: has(doc, 'video.vjs-tech'),
      },
      jobs: jobs,
      videos: collectVideos(doc),
      catalog: collectCatalog(doc),
      iframeDetails: collectFrames(doc),
    };
  }

  // ---------- 子 frame：上报 ----------
  function reportUp(seq) {
    try {
      window.top.postMessage(collectLocal(seq), '*');
    } catch (e) {
      /* 跨域或序列化失败：顶层会把该 frame 标为未上报 */
    }
  }

  // ---------- 顶层：汇总 ----------
  function initTop() {
    const reports = new Map();

    window.addEventListener('message', function (event) {
      const data = event.data;
      if (!data || data.channel !== CHANNEL || data.kind !== 'frame-report') return;
      const previous = reports.get(event.source);
      if (!previous || (data.seq || 0) >= (previous.seq || 0)) {
        reports.set(event.source, data);
      }
    });

    function walkFrames(win, depth, out) {
      if (depth > MAX_DEPTH) return;
      let doc = null;
      try {
        doc = win.document;
      } catch (e) {
        return;
      }
      if (!doc) return;

      let frames = [];
      try {
        frames = Array.prototype.slice.call(doc.querySelectorAll('iframe'));
      } catch (e) {
        frames = [];
      }

      for (const frame of frames) {
        let childWin = null;
        let sameOriginDoc = false;
        let errorName = '';
        try {
          childWin = frame.contentWindow;
        } catch (e) {
          childWin = null;
          errorName = (e && e.name) || 'Error';
        }
        try {
          sameOriginDoc = !!frame.contentDocument;
        } catch (e) {
          sameOriginDoc = false;
          errorName = (e && e.name) || 'Error';
        }
        const report = childWin ? reports.get(childWin) || null : null;
        out.push({
          depth: depth + 1,
          src: safeUrl(frame.getAttribute('src'), doc.baseURI),
          frameId: frame.id || '',
          frameClass: String(frame.className || '').slice(0, 100),
          sameOriginDoc: sameOriginDoc,
          errorName: errorName,
          sandbox: frame.getAttribute('sandbox'),
          injected: !!report,
          report: report,
        });
        if (childWin && sameOriginDoc) walkFrames(childWin, depth + 1, out);
      }
    }

    function buildExport() {
      const frames = [];
      walkFrames(window, 0, frames);

      const summary = {
        frameCount: frames.length,
        sameOriginCount: 0,
        crossOriginCount: 0,
        injectedCount: 0,
        totalJobs: 0,
        jobStates: { withUnfinishedLabel: 0, withFinishedLabel: 0, withFinishedClass: 0, noMarker: 0 },
        totalVideos: 0,
        catalogLeaf: 0,
        catalogFirstLayer: 0,
        catalogPending: 0,
        catalogPendingUnknown: 0,
        hasPrevNextFocusNext: false,
        hasNextChapter: false,
        hasVideoQuiz: false,
        jobContainerClasses: {},
        notes: [],
      };

      const allReports = [];
      const localReport = collectLocal(999);
      allReports.push({ where: 'top', report: localReport });

      for (const frame of frames) {
        if (!frame.report) continue;
        allReports.push({ where: 'depth-' + frame.depth, report: frame.report });
      }

      for (const entry of allReports) {
        const r = entry.report;
        summary.totalJobs += (r.jobs || []).length;
        summary.totalVideos += (r.videos || []).length;
        if (r.catalog) {
          summary.catalogLeaf += r.catalog.leafCount || 0;
          summary.catalogFirstLayer += r.catalog.firstLayerCount || 0;
          summary.catalogPending += r.catalog.pendingSum || 0;
          summary.catalogPendingUnknown += r.catalog.pendingUnknown || 0;
        }
        if (r.selectors && r.selectors.prevNextFocusNext) summary.hasPrevNextFocusNext = true;
        if (r.selectors && r.selectors.nextChapter) summary.hasNextChapter = true;
        if ((r.counts && r.counts.ansVideoquiz > 0) || (r.counts && r.counts.dataVideoQuizRoot > 0)) {
          summary.hasVideoQuiz = true;
        }
        for (const job of r.jobs || []) {
          const label = String(job.iconLabel || '');
          let matched = false;
          if (job.hasFinishedClass) {
            summary.jobStates.withFinishedClass++;
            matched = true;
          }
          if (label.indexOf('未完成') !== -1) {
            summary.jobStates.withUnfinishedLabel++;
            matched = true;
          } else if (label.indexOf('已完成') !== -1) {
            summary.jobStates.withFinishedLabel++;
            matched = true;
          }
          if (!matched) summary.jobStates.noMarker++;
          // 记录实际出现的容器类名，便于确认选择器
          const cls = String(job.classes || '').split(/\s+/)[0];
          if (cls) summary.jobContainerClasses[cls] = (summary.jobContainerClasses[cls] || 0) + 1;
        }
      }

      for (const frame of frames) {
        if (frame.sameOriginDoc) summary.sameOriginCount++;
        else summary.crossOriginCount++;
        if (frame.injected) summary.injectedCount++;
      }

      const unreadable = frames.filter(function (f) {
        return !f.sameOriginDoc;
      });
      if (unreadable.length) {
        summary.notes.push(
          unreadable.length +
            ' 个 iframe 不可读；可观测原因：' +
            unreadable
              .slice(0, 4)
              .map(function (f) {
                return (
                  (f.errorName || 'unknown') +
                  ' sandbox=' + f.sandbox +
                  ' src=' + f.src
                );
              })
              .join(' ; ')
        );
        summary.notes.push(
          '注意：跨域可能来自 document.domain 不对称、sandbox、CSP frame-ancestors、' +
            '或不同子域等多种原因；本探针只记录可观测属性，未下唯一结论。'
        );
      }
      if (!frames.length) {
        summary.notes.push('当前文档没有 iframe。若你在课程页看到视频，说明播放器不在 iframe 里，或注入时机过早。');
      }
      if (!summary.totalJobs) {
        summary.notes.push('未采集到任务点容器（.ans-attach-ct / .ans-job 均未命中）。');
      }

      return {
        probeVersion: PROBE_VERSION,
        exportedAt: new Date().toISOString(),
        summary: summary,
        frames: frames,
        topReport: localReport,
        allReports: allReports,
      };
    }

    function mountButton() {
      const host = document.createElement('div');
      host.id = 'cx-probe-host';
      host.style.cssText = 'all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483000;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial}' +
        '.btn{font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
        'background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:7px 12px;cursor:pointer;' +
        'box-shadow:0 4px 14px rgba(16,24,40,.25)}' +
        '.btn:hover{background:#2a63d4}' +
        '.toast{margin-top:6px;font:11px/1.4 monospace;color:#1f2430;background:#fff;' +
        'border:1px solid #d8dee9;border-radius:6px;padding:5px 8px;max-width:260px;display:none}' +
        '.toast.show{display:block}';
      shadow.appendChild(style);

      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '📋 导出探针数据';
      const toast = document.createElement('div');
      toast.className = 'toast';

      btn.addEventListener('click', function () {
        let data;
        try {
          data = buildExport();
        } catch (e) {
          toast.textContent = '导出失败：' + (e && e.message);
          toast.classList.add('show');
          return;
        }
        const json = JSON.stringify(data, null, 2);
        console.log('[学习通探针] 导出数据\n' + json);
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(json).then(
              function () {
                toast.textContent = '已复制 ' + Math.round(json.length / 1024) + ' KB（已脱敏，可直接粘贴）';
                toast.classList.add('show');
              },
              function () {
                toast.textContent = '复制失败，请从控制台复制（已打印）。';
                toast.classList.add('show');
              }
            );
          } else {
            toast.textContent = '剪贴板不可用，请从控制台复制（已打印）。';
            toast.classList.add('show');
          }
        } catch (e) {
          toast.textContent = '复制异常，请从控制台复制。';
          toast.classList.add('show');
        }
      });

      shadow.appendChild(btn);
      shadow.appendChild(toast);
      (document.body || document.documentElement).appendChild(host);
    }

    for (const delay of SAMPLE_AT) {
      setTimeout(function () {
        try {
          reports.set(window, collectLocal(delay));
        } catch (e) {
          /* ignore */
        }
      }, delay);
    }

    setTimeout(function () {
      try {
        mountButton();
      } catch (e) {
        /* ignore */
      }
    }, SAMPLE_AT[SAMPLE_AT.length - 1] + 400);
  }

  if (isTop) initTop();

  const seqBase = Date.now();
  for (let i = 0; i < SAMPLE_AT.length; i++) {
    (function (index) {
      setTimeout(function () {
        reportUp(seqBase + index);
      }, SAMPLE_AT[index]);
    })(i);
  }
})();
