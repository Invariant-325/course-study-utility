// ---------------------------------------------------------------------------
// chapter-quiz.js —— 独立章节测验适配器与编排（阶段 D2）
//
// 真实页面证据（2026-11-10 实测 mooc1/.../mooc-ans/work/doHomeWorkNew?workId=…）：
//   题目容器   .TiMu（类 .TiMu newTiMu，带 data="0..n"）
//   题号       .Zy_TItle i
//   题型标签   .newZy_TItle（【单选题】/【多选题】）
//   题干       .Zy_TItle .fontLabel
//   选项列表   ul.Zy_ulTop li
//   选项字母   li span[data]（单选 .num_option / 多选 .num_option_dx，都有 data）
//   选项文本   li a.after
//   选项标识   li[qid]、li[qtype]（0=单选 1=多选）、li[role]=radio/checkbox
//   点击行为   li[onclick]=addChoice(this) / addMultipleChoice(this)
//   按钮       .btnSave（暂时保存）、.btnSubmit（提交）
//   分页       无
//
// 关键陷阱（实测）：
//   **选项字母顺序被打乱**：第 1 题的 DOM 顺序对应字母 [D,A,C,B]。
//   因此必须用 data 属性取字母，绝不能按 DOM 索引推断 A/B/C/D。
//
// 字体加密（实测）：
//   题干与选项带 .font-cxsecret，textContent 是被替换的字符
//   （如「全面从严治党」读作「全嵅从嵆治嵃」），
//   而 font-cxsecret 是 base64 内联 TTF，**渲染后才显示正确文字**。
//   本轮用 16×16 Canvas 粗特征比对做了可行性验证：失败（"嵅"→"面" 排第 194 位）。
//   因此本模块只检测并标记 encrypted，不尝试解密；标记后不请求模型。
// ---------------------------------------------------------------------------
const ChapterQuizAdapter = (function () {
  const QSEL = {
    root: '.TiMu',
    num: '.Zy_TItle i',
    typeLabel: '.newZy_TItle',
    stem: '.Zy_TItle .fontLabel',
    optionList: 'ul.Zy_ulTop',
    optionItem: 'li',
    optionLetter: 'span[data]',
    optionText: 'a.after',
    saveBtn: '.btnSave',
    submitBtn: '.btnSubmit',
    encrypted: '.font-cxsecret',
  };

  const TYPE = {
    single: 'single',
    multiple: 'multiple',
    judge: 'judge',
    blank: 'blank',
    unknown: 'unknown',
  };

  const TYPE_LABELS = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    blank: '填空题',
    unknown: '未知题型',
  };

  function textOf(el) {
    if (!el) return '';
    try {
      return String(el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  function isSelected(li) {
    if (!li) return null;
    try {
      const cls = String(li.className || '');
      // 用连字符/空白做边界，避免把 before-after-checkbox 里的 "check" 误判为选中，
      // 同时仍能识别 before-after-select 这类选中标记。
      if (/(^|[\s-])(selected|select|active|cur|checked)([\s-]|$)/i.test(cls)) return true;
      const aria = li.getAttribute('aria-checked');
      if (aria === 'true') return true;
      if (aria === 'false') return false;
      // 没有明确选中标记时按未选中处理；填写后 verify() 会重新读取并报告不一致，
      // 因此宁可漏判"已选中"（多填一次，可自检），也不要误判"已选中"（拒绝填写）。
      return false;
    } catch (e) {
      return null;
    }
  }

  function mapType(label, options) {
    if (label.indexOf('单选') !== -1) return TYPE.single;
    if (label.indexOf('多选') !== -1) return TYPE.multiple;
    if (label.indexOf('判断') !== -1) return TYPE.judge;
    if (label.indexOf('填空') !== -1) return TYPE.blank;
    if (label.indexOf('简答') !== -1 || label.indexOf('问答') !== -1) return TYPE.unknown;

    const roles = options.map(function (o) { return o.role; }).filter(Boolean);
    if (roles.length && roles.every(function (r) { return r === 'radio'; })) return TYPE.single;
    if (roles.some(function (r) { return r === 'checkbox'; })) return TYPE.multiple;
    return TYPE.unknown;
  }

  function parseOne(el, index) {
    const numEl = el.querySelector(QSEL.num);
    const typeEl = el.querySelector(QSEL.typeLabel);
    const stemEl = el.querySelector(QSEL.stem);

    const typeLabel = textOf(typeEl);
    let stem = textOf(stemEl);
    // 去掉题干开头的【单选题】前缀
    if (typeLabel && stem.indexOf(typeLabel) === 0) {
      stem = stem.slice(typeLabel.length).trim();
    }

    const liList = Dom.toArray(el.querySelectorAll(QSEL.optionList + ' ' + QSEL.optionItem));
    const options = liList.map(function (li, i) {
      const letterEl = li.querySelector(QSEL.optionLetter);
      // 实测结构：<span class="num_option" data="D">A</span>
      //   data   = 平台内部答案标识（可能被随机化，用于防抓取）
      //   文本   = 用户在页面上看到的字母（A/B/C/D，按视觉顺序）
      // 必须区分这两者：给用户/模型看的是文本，回填时也按文本匹配，
      // 绝不能把 data 当成显示字母，否则答案会错位。
      const internal = letterEl ? String(letterEl.getAttribute('data') || '').trim().toUpperCase() : '';
      const display = letterEl ? textOf(letterEl).toUpperCase() : '';
      return {
        letter: /^[A-H]$/.test(display) ? display : '',
        internal: /^[A-H]$/.test(internal) ? internal : '',
        text: textOf(li.querySelector(QSEL.optionText)),
        qid: li.getAttribute('qid') || '',
        qtype: li.getAttribute('qtype') || '',
        role: li.getAttribute('role') || '',
        index: i,
        selected: isSelected(li),
        el: li,
      };
    });

    const type = mapType(typeLabel, options);
    const encrypted = !!el.querySelector(QSEL.encrypted);
    const num = textOf(numEl);

    // 稳定标识：题号 + 题型 + 选项 qid + 内部标识序列
    // 用 internal 而不是显示字母，因为显示字母可能随顺序变化，内部标识更稳定
    const qidKey = options.map(function (o) { return o.qid; }).join('-');
    const internalKey = options.map(function (o) { return o.internal; }).join('');
    const key = [num || '#' + index, type, qidKey, internalKey].join('|');

    const missingLetters = options.some(function (o) { return !o.letter; });

    return {
      index: index,
      key: key,
      num: num,
      type: type,
      typeLabel: typeLabel || TYPE_LABELS[type],
      stem: stem,
      options: options,
      encrypted: encrypted,
      missingLetters: missingLetters,
      answered: options.some(function (o) { return o.selected === true; }),
      el: el,
    };
  }

  /**
   * 解析整份测验（只读）。
   * @returns {{ok:boolean, reason:string, count:number, questions:Array, encryptedCount:number, warnings:Array}}
   */
  function parse(doc) {
    const target = doc || document;
    let nodes = [];
    try {
      nodes = Dom.toArray(target.querySelectorAll(QSEL.root));
    } catch (e) {
      nodes = [];
    }

    if (!nodes.length) {
      return {
        ok: false,
        reason: 'no-quiz-root',
        count: 0,
        questions: [],
        encryptedCount: 0,
        warnings: [],
      };
    }

    const questions = nodes.map(function (el, i) {
      return parseOne(el, i);
    });

    const warnings = [];
    const encryptedCount = questions.filter(function (q) { return q.encrypted; }).length;
    if (encryptedCount) {
      warnings.push(
        encryptedCount +
          ' 道题的内容被 .font-cxsecret 字体加密，textContent 是替换字符。' +
          '本模块不做解密，这些题不会请求模型。'
      );
    }
    const noLetter = questions.filter(function (q) { return q.missingLetters; }).length;
    if (noLetter) {
      warnings.push(noLetter + ' 道题缺少选项字母（data 属性），已标记为不可自动填写');
    }
    const unknown = questions.filter(function (q) { return q.type === TYPE.unknown; }).length;
    if (unknown) {
      warnings.push(unknown + ' 道题题型无法识别，需要人工处理');
    }

    return {
      ok: true,
      reason: '',
      count: questions.length,
      questions: questions,
      encryptedCount: encryptedCount,
      warnings: warnings,
    };
  }

  // 当前是否处于测验页面
  function detect(doc) {
    const target = doc || document;
    try {
      if (!/\/work\/doHomeWorkNew/i.test(String(target.URL || ''))) {
        return { isQuizPage: false, reason: 'url-not-quiz' };
      }
      const count = target.querySelectorAll(QSEL.root).length;
      return { isQuizPage: count > 0, count: count, reason: count ? '' : 'no-questions' };
    } catch (e) {
      return { isQuizPage: false, reason: 'error' };
    }
  }

  /**
   * 按显示字母填写答案（绝不按 DOM 索引或内部标识）。
   * @param {object} question parse 出来的单题
   * @param {string[]} letters 目标字母（用户/模型看到的字母）
   * @param {object} options { force:boolean, source:'text'|'vision' }
   *   force=true 才覆盖已选答案
   *   source='vision' 表示答案来自视觉识别，此时加密题目允许填写
   *   （加密只是让 textContent 不可读，不影响选项字母与点击；
   *     视觉识别正是为了绕过这一点，答案与选项的对应仍由 letter 保证）
   */
  function fill(question, letters, options) {
    const opts = options || {};
    if (!question) return { ok: false, applied: 0, errors: ['没有题目'] };
    if (question.encrypted && opts.source !== 'vision') {
      return {
        ok: false,
        applied: 0,
        errors: ['题目文本加密；只有答案来自视觉识别时才允许填写'],
      };
    }
    if (question.missingLetters) {
      return { ok: false, applied: 0, errors: ['选项缺少字母标识，无法安全匹配'] };
    }

    const target = new Set((letters || []).map(function (l) { return String(l).toUpperCase(); }));
    const errors = [];
    const known = new Set(question.options.map(function (o) { return o.letter; }));

    for (const letter of target) {
      if (!known.has(letter)) errors.push('选项不存在：' + letter);
    }
    if (errors.length) return { ok: false, applied: 0, errors: errors };

    // 已有答案且未授权覆盖：拒绝
    if (question.answered && !opts.force) {
      return { ok: false, applied: 0, errors: ['该题已有填写内容，需明确授权才能覆盖'] };
    }

    let applied = 0;
    for (const option of question.options) {
      const shouldPick = target.has(option.letter);
      const currently = option.selected;

      // currently 为 null 表示无法判断，交给外层填写后自检
      if (shouldPick) {
        if (currently === true) continue;
        if (Dom.click(option.el)) applied++;
      } else if (currently === true) {
        // 多选题需要取消未选中的已选项（addMultipleChoice 是 toggle）
        if (Dom.click(option.el)) applied++;
      }
    }

    return { ok: true, applied: applied, errors: [] };
  }

  // 填写后自检：重新读 DOM，确认目标字母都被选中
  function verify(question, letters) {
    if (!question) return { ok: false, detail: 'no-question' };
    const target = new Set((letters || []).map(function (l) { return String(l).toUpperCase(); }));
    const unknown = [];
    const wrong = [];

    for (const option of question.options) {
      const now = isSelected(option.el);
      if (now === null) {
        unknown.push(option.letter);
        continue;
      }
      const want = target.has(option.letter);
      if (now !== want) wrong.push({ letter: option.letter, selected: now, want: want });
    }

    if (unknown.length && !wrong.length) {
      return { ok: false, unknown: unknown, detail: '无法读取选中状态，需要人工确认' };
    }
    if (wrong.length) {
      return { ok: false, wrong: wrong, detail: '填写后状态与预期不一致' };
    }
    return { ok: true, detail: 'ok' };
  }

  function buttons(doc) {
    const target = doc || document;
    const result = { save: null, submit: null };
    try {
      result.save = target.querySelector(QSEL.saveBtn);
      result.submit = target.querySelector(QSEL.submitBtn);
    } catch (e) {
      /* ignore */
    }
    return result;
  }

  return {
    QSEL,
    TYPE,
    TYPE_LABELS,
    parse,
    detect,
    fill,
    verify,
    buttons,
    isSelected,
  };
})();
