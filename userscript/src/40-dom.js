// ---------------------------------------------------------------------------
// dom.js —— 跨 iframe 的文档收集与安全操作
// 学习通课程页典型嵌套：顶层 -> #iframe(卡片列表) -> 任务点 iframe(播放器)
// 三层通常同源；跨域时一律跳过，不做任何绕过尝试。
// ---------------------------------------------------------------------------
const Dom = (function () {
  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      if (!view) return false;
      const style = view.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 用真实 MouseEvent 序列点击，尽量贴近用户操作（不直接改 DOM 状态）
  // 注意：对 input/button/label/a 这类表单控件只调用 click()。
  // 若既 dispatch click 又调用 click()，checkbox 会被切换两次（等于没勾上）。
  function click(el) {
    if (!el) return false;
    try {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const tag = String(el.tagName || '').toLowerCase();

      if (['input', 'button', 'label', 'a', 'select'].indexOf(tag) !== -1 && typeof el.click === 'function') {
        el.click();
        return true;
      }

      let rect = { left: 0, top: 0, width: 0, height: 0 };
      try {
        rect = el.getBoundingClientRect();
      } catch (e) {
        /* ignore */
      }
      const base = {
        bubbles: true,
        cancelable: true,
        view: view,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      };
      el.dispatchEvent(new view.MouseEvent('mousedown', base));
      el.dispatchEvent(new view.MouseEvent('mouseup', base));
      el.dispatchEvent(new view.MouseEvent('click', base));
      return true;
    } catch (e) {
      Log.warn('点击元素失败', e && e.message);
      return false;
    }
  }

  // 广度优先收集所有同源可达文档
  // 返回 { documents: [{ doc, win, depth, frameEl }], inaccessible: [{ frameEl, src, depth, reason }] }
  // inaccessible 必须被上层显式处理：不能静默丢掉，否则"找不到任务点"无从解释。
  function collectDocuments(rootWindow, maxDepth) {
    const out = [];
    const inaccessible = [];
    const seenDocs = new Set();
    const queue = [{ win: rootWindow, depth: 0, frameEl: null }];

    while (queue.length) {
      const item = queue.shift();
      let doc = null;
      try {
        doc = item.win && item.win.document;
      } catch (e) {
        if (item.frameEl) {
          inaccessible.push({
            frameEl: item.frameEl,
            src: item.frameEl.getAttribute ? item.frameEl.getAttribute('src') || '' : '',
            depth: item.depth,
            reason: 'document-access-denied',
          });
        }
        continue;
      }
      if (!doc || seenDocs.has(doc)) continue;
      seenDocs.add(doc);
      out.push({ doc: doc, win: item.win, depth: item.depth, frameEl: item.frameEl });

      if (item.depth >= maxDepth) continue;

      for (const frame of toArray(doc.querySelectorAll('iframe'))) {
        let childWin = null;
        try {
          childWin = frame.contentWindow;
        } catch (e) {
          childWin = null;
        }
        if (!childWin) {
          inaccessible.push({
            frameEl: frame,
            src: frame.getAttribute('src') || '',
            depth: item.depth + 1,
            reason: 'no-content-window',
          });
          continue;
        }
        let childDoc = null;
        try {
          childDoc = childWin.document;
        } catch (e) {
          inaccessible.push({
            frameEl: frame,
            src: frame.getAttribute('src') || '',
            depth: item.depth + 1,
            reason: 'cross-origin:' + ((e && e.name) || 'SecurityError'),
          });
          continue;
        }
        if (!childDoc) {
          inaccessible.push({
            frameEl: frame,
            src: frame.getAttribute('src') || '',
            depth: item.depth + 1,
            reason: 'empty-document',
          });
          continue;
        }
        queue.push({ win: childWin, depth: item.depth + 1, frameEl: frame });
      }
    }
    return { documents: out, inaccessible: inaccessible };
  }

  function parseFrameData(frameEl) {
    if (!frameEl) return null;
    const raw = frameEl.getAttribute('data');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // 解析 iframe 的绝对地址（相对地址按所属文档补全）
  function frameUrl(frameEl) {
    if (!frameEl) return '';
    const src = frameEl.getAttribute('src') || '';
    if (!src) return '';
    try {
      const doc = frameEl.ownerDocument;
      const base = (doc && doc.baseURI) || location.href;
      return new URL(src, base).href;
    } catch (e) {
      return src;
    }
  }

  function textOf(el, limit) {
    if (!el) return '';
    let text = '';
    try {
      text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      text = '';
    }
    const max = limit || 80;
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function stopObserver(observer) {
    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function waitTimeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    toArray,
    isVisible,
    click,
    collectDocuments,
    parseFrameData,
    frameUrl,
    textOf,
    stopObserver,
    waitTimeout,
  };
})();
