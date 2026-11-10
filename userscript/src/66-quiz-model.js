// ---------------------------------------------------------------------------
// quiz-model.js —— 弹题 DOM 解析与模型输出校验（纯逻辑，可单测）
//
// 设计原则：
//   1. 只读解析，不做任何点击。
//   2. 题型优先由 input 类型判断（radio/checkbox），比文字猜测可靠。
//   3. 模型输出必须与真实选项集合对齐，任何越界选项一律拒绝。
//   4. 无法可靠识别时返回 ok:false，由上层转人工，不猜测。
//
// 真实弹题 DOM 尚未实机采集（阶段 C 只验证了视频连播），
// 因此所有选择器都是多候选，解析结果必须经过 validateQuestion 才可用于提问。
// ---------------------------------------------------------------------------
const QuizModel = (function () {
  const TYPES = { single: 'single', multiple: 'multiple', judge: 'judge', unknown: 'unknown' };

  const TYPE_LABELS = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    unknown: '未知题型',
  };

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function textOf(el) {
    try {
      return normalize(el && el.textContent);
    } catch (e) {
      return '';
    }
  }

  // 稳定 hash：题干 + 选项文本，用于题目去重与请求去重
  function hash(text) {
    let h = 5381;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
      h = ((h << 5) + h + source.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function findRoot(doc) {
    for (const selector of SEL.quizRoot) {
      try {
        const el = doc.querySelector(selector);
        if (el && Dom.isVisible(el)) return el;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  // 选项容器：优先"包含 input 的最接近容器"，避免把无关 li 算进来
  function findOptionItems(root) {
    const items = [];
    const seen = new Set();

    let inputs = [];
    try {
      inputs = Dom.toArray(root.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    } catch (e) {
      inputs = [];
    }

    if (inputs.length) {
      for (const input of inputs) {
        let box = null;
        try {
          box = input.closest('label, li, .option, .option-item, [class*="option"], [class*="item"]');
        } catch (e) {
          box = null;
        }
        if (!box) box = input.parentElement;
        if (!box || seen.has(box)) continue;
        seen.add(box);
        items.push({ box: box, input: input });
      }
      if (items.length) return items;
    }

    for (const selector of SEL.quizOptionBox) {
      let nodes = [];
      try {
        nodes = Dom.toArray(root.querySelectorAll(selector));
      } catch (e) {
        nodes = [];
      }
      for (const node of nodes) {
        if (seen.has(node)) continue;
        // 过滤掉明显是容器而非选项的节点
        if (node.querySelector && node.querySelector('li, label')) continue;
        seen.add(node);
        items.push({ box: node, input: null });
      }
      if (items.length) break;
    }
    return items;
  }

  function letterOf(item, index) {
    let text = '';
    try {
      text = textOf(item.box);
    } catch (e) {
      text = '';
    }
    const match = text.match(SEL.quizLetterPattern);
    if (match) return match[1];

    if (item.input) {
      const value = String(item.input.value || '').trim();
      if (/^[A-H]$/i.test(value)) return value.toUpperCase();
    }
    return String.fromCharCode(65 + index);
  }

  function optionText(item, letter) {
    let text = textOf(item.box);
    if (!text) return '';
    // 去掉 "A." 之类前缀与结尾的占位
    text = text.replace(SEL.quizLetterPattern, '');
    return text.slice(0, 200);
  }

  function detectType(root, items) {
    let hasCheckbox = false;
    let hasRadio = false;
    for (const item of items) {
      if (!item.input) continue;
      const type = String(item.input.type || '').toLowerCase();
      if (type === 'checkbox') hasCheckbox = true;
      if (type === 'radio') hasRadio = true;
    }
    if (hasCheckbox) return TYPES.multiple;
    if (hasRadio) {
      // 判断题：两个选项且文本是 正确/错误 之类
      const texts = items.map(function (item) {
        return optionText(item).replace(SEL.quizLetterPattern, '').trim();
      });
      if (texts.length === 2 && texts.every(function (t) { return SEL.quizJudgeWords.test(t); })) {
        return TYPES.judge;
      }
      return TYPES.single;
    }
    return TYPES.unknown;
  }

  function findStem(root, items) {
    for (const selector of SEL.quizStem) {
      let el = null;
      try {
        el = root.querySelector(selector);
      } catch (e) {
        continue;
      }
      if (!el) continue;
      // 题干不能是选项本身
      let isOption = false;
      for (const item of items) {
        try {
          if (item.box === el || item.box.contains(el)) {
            isOption = true;
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (isOption) continue;
      const text = textOf(el);
      if (text && text.length >= 4) return text.slice(0, 500);
    }

    // 兜底：容器文本去掉选项文本
    let containerText = textOf(root);
    for (const item of items) {
      containerText = containerText.replace(textOf(item.box), ' ');
    }
    containerText = normalize(containerText);
    return containerText ? containerText.slice(0, 500) : '';
  }

  /**
   * 解析当前弹题。
   * @returns {{ok:boolean, reason:string, root:Element|null, type:string, stem:string,
   *            options:Array<{letter:string,text:string,input:Element|null,box:Element}>,
   *            hash:string}}
   */
  function parse(doc) {
    const root = findRoot(doc || document);
    if (!root) {
      return { ok: false, reason: 'no-quiz-root', root: null, type: TYPES.unknown, stem: '', options: [], hash: '' };
    }

    const items = findOptionItems(root);
    if (!items.length) {
      return { ok: false, reason: 'no-options', root: root, type: TYPES.unknown, stem: '', options: [], hash: '' };
    }

    const options = [];
    const usedLetters = new Set();
    for (let i = 0; i < items.length; i++) {
      let letter = letterOf(items[i], i);
      // 字母冲突时按序回退，保证唯一
      if (usedLetters.has(letter)) {
        letter = String.fromCharCode(65 + i);
      }
      usedLetters.add(letter);
      options.push({
        letter: letter,
        text: optionText(items[i], letter),
        input: items[i].input,
        box: items[i].box,
      });
    }

    const type = detectType(root, items);
    const stem = findStem(root, items);
    const hashInput = stem + '|' + options.map(function (o) { return o.letter + ':' + o.text; }).join('|');

    const result = {
      ok: false,
      reason: '',
      root: root,
      type: type,
      stem: stem,
      options: options,
      hash: hash(hashInput),
    };

    if (type === TYPES.unknown) {
      result.reason = 'unknown-type';
      return result;
    }
    if (!stem || stem.length < 4) {
      result.reason = 'no-stem';
      return result;
    }
    if (options.length < 2) {
      result.reason = 'too-few-options';
      return result;
    }
    if (options.filter(function (o) { return o.text; }).length < 2) {
      result.reason = 'empty-option-text';
      return result;
    }

    result.ok = true;
    return result;
  }

  // 选项是否已被勾选（用于"应用建议"后自检）
  function isChecked(option) {
    if (!option || !option.input) return null;
    try {
      return !!option.input.checked;
    } catch (e) {
      return null;
    }
  }

  /**
   * 校验模型输出与真实选项的对齐关系。
   * 任何越界字母、类型冲突都会被拒绝，不做"尽量猜"。
   * @param {object} question parse() 的结果
   * @param {any} raw 模型返回的解析后对象
   */
  function validateAnswer(question, raw) {
    const errors = [];
    let letters = [];
    let reason = '';
    let uncertain = true;
    let confidence = 0;

    if (!question || !question.ok) errors.push('题目未成功解析');

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('模型输出不是对象');
    } else {
      if (Array.isArray(raw.answer)) {
        letters = raw.answer.map(function (item) { return String(item).trim().toUpperCase(); });
      } else if (typeof raw.answer === 'string') {
        letters = raw.answer.split(/[,，、\s]+/).map(function (item) { return item.trim().toUpperCase(); });
      } else {
        errors.push('answer 字段缺失或类型错误');
      }

      reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '';
      uncertain = raw.uncertain === true;

      const parsedConfidence = Number(raw.confidence);
      confidence = isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : 0;
    }

    // 只接受单个大写字母 A-H。
    // 注意：不能静默丢弃非法项——模型给了 "Z" 或 "AB" 时必须报错，
    // 否则上层会误以为答案合法而展示一个被悄悄改过的结果。
    const malformed = letters.filter(function (item) {
      return !/^[A-H]$/.test(item);
    });
    if (malformed.length) errors.push('非法选项格式：' + malformed.join(','));
    letters = letters.filter(function (item) {
      return /^[A-H]$/.test(item);
    });

    const valid = new Set((question && question.options ? question.options : []).map(function (o) { return o.letter; }));
    const invalid = letters.filter(function (item) { return !valid.has(item); });
    if (invalid.length) errors.push('选项不存在：' + invalid.join(','));
    letters = letters.filter(function (item) { return valid.has(item); });

    // 去重
    letters = Array.from(new Set(letters));

    if (question && (question.type === TYPES.single || question.type === TYPES.judge)) {
      if (letters.length > 1) {
        errors.push('单选题返回了多个答案');
        letters = letters.slice(0, 1);
      }
    }
    if (letters.length === 0) errors.push('答案为空');

    // 多选题若模型给了 confidence 很低，标记为不确定（仍需人工判断）
    if (uncertain && confidence > 0.8) confidence = 0.8;

    return {
      ok: errors.length === 0,
      letters: letters,
      reason: reason,
      uncertain: uncertain,
      confidence: confidence,
      errors: errors,
    };
  }

  // 给模型看的选项列表（去掉 DOM 细节，只保留字母与文本）
  function toPromptPayload(question) {
    return {
      stem: question.stem,
      typeLabel: TYPE_LABELS[question.type] || '未知题型',
      options: question.options.map(function (option) {
        return { letter: option.letter, text: option.text };
      }),
    };
  }

  return {
    TYPES,
    TYPE_LABELS,
    parse,
    validateAnswer,
    toPromptPayload,
    isChecked,
    hash,
    normalize,
    findRoot,
  };
})();
