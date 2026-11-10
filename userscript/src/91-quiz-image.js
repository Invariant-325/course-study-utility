// ---------------------------------------------------------------------------
// quiz-image.js —— 题目图像提取（阶段 D2 视觉链路）
//
// 为什么不用 DOM 截图或 foreignObject：
//   - 用户脚本无法截屏；
//   - foreignObject 需要把内联 base64 字体再塞进 SVG，体积与兼容性都不可控。
// 采用 Canvas 直接绘制文本，字体沿用页面已加载的 font-cxsecret：
//   实测该字体渲染加密字符时显示的是正确汉字，所以 Canvas 用同一字体也能得到正确字形。
//
// 重要限制（用户明确要求不能假设 DOM 都渲染正确）：
//   - 只绘制我们显式提取并排版的文本（题干 + 选项），不克隆原 DOM
//   - 题目内含图片/公式/img 时标记 unsupported，不假装能正确渲染
//   - 高度超过上限标记 tooTall，交由调用方分段
//
// 输出：{ ok, dataUrl, width, height, unsupported, encrypted }
// ---------------------------------------------------------------------------
const QuizImage = (function () {
  const WIDTH = 900;
  const PADDING = 24;
  const FONT_SIZE = 22;
  const LINE_HEIGHT = 34;
  const OPTION_GAP = 6;
  const MAX_HEIGHT = 4000;
  const MAX_WIDTH = 4096;

  const ENCRYPTED_FONT = '"font-cxsecret", "Microsoft YaHei", sans-serif';
  const PLAIN_FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

  function fontFor(encrypted) {
    return '400 ' + FONT_SIZE + 'px ' + (encrypted ? ENCRYPTED_FONT : PLAIN_FONT);
  }

  function wrapText(ctx, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const ch of String(text || '')) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  // 检测题目里是否含我们无法可靠绘制的元素
  function detectUnsupported(questionEl) {
    const unsupported = [];
    if (!questionEl) return unsupported;
    try {
      if (questionEl.querySelector('img, svg, video, canvas, iframe')) {
        unsupported.push('image-or-formula');
      }
      // MathJax / KaTeX 公式容器
      if (questionEl.querySelector('.MathJax, .katex, mjx-container, math')) {
        unsupported.push('math');
      }
    } catch (e) {
      /* ignore */
    }
    return unsupported;
  }

  /**
   * 把一道题渲染成 PNG dataURL。
   * @param {object} question ChapterQuizAdapter.parse 出来的单题
   * @param {object} options { scale:number }
   */
  function render(question, options) {
    const opts = options || {};
    if (!question) return { ok: false, reason: 'no-question' };

    const scale = Number(opts.scale) || 2; // 2x 提升识别精度
    const unsupported = detectUnsupported(question.el);
    const encrypted = !!question.encrypted;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'no-2d-context' };

    ctx.font = fontFor(encrypted);
    const textWidth = WIDTH - PADDING * 2;

    const blocks = [];
    // 标题行
    blocks.push({ kind: 'title', text: '第 ' + (question.num || '?') + ' 题 ' + (question.typeLabel || '') });
    // 题干
    for (const line of wrapText(ctx, question.stem, textWidth)) {
      blocks.push({ kind: 'stem', text: line });
    }
    blocks.push({ kind: 'gap', text: '' });
    // 选项
    for (const option of question.options) {
      const prefix = (option.letter || '?') + '  ';
      const wrapped = wrapText(ctx, prefix + option.text, textWidth);
      for (let i = 0; i < wrapped.length; i++) {
        blocks.push({ kind: i === 0 ? 'option' : 'option-cont', text: wrapped[i] });
      }
    }

    // 计算高度
    let height = PADDING;
    for (const block of blocks) {
      height += block.kind === 'gap' ? 12 : LINE_HEIGHT;
      if (block.kind === 'option') height += OPTION_GAP;
    }
    height += PADDING;

    if (height > MAX_HEIGHT) {
      return { ok: false, reason: 'tooTall', height: height, unsupported: unsupported };
    }
    if (WIDTH * scale > MAX_WIDTH) {
      return { ok: false, reason: 'tooWide', unsupported: unsupported };
    }

    canvas.width = WIDTH * scale;
    canvas.height = height * scale;
    ctx.scale(scale, scale);

    // 白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, height);
    ctx.fillStyle = '#111111';
    ctx.textBaseline = 'top';

    let y = PADDING;
    for (const block of blocks) {
      if (block.kind === 'gap') {
        y += 12;
        continue;
      }
      if (block.kind === 'title') {
        ctx.font = '600 ' + (FONT_SIZE - 2) + 'px ' + (encrypted ? ENCRYPTED_FONT : PLAIN_FONT);
        ctx.fillStyle = '#444444';
      } else if (block.kind === 'stem') {
        ctx.font = fontFor(encrypted);
        ctx.fillStyle = '#111111';
      } else {
        ctx.font = fontFor(encrypted);
        ctx.fillStyle = '#1f2430';
        if (block.kind === 'option') y += OPTION_GAP;
      }
      ctx.fillText(block.text, PADDING, y);
      y += LINE_HEIGHT;
    }

    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (e) {
      return { ok: false, reason: 'toDataUrl-failed', unsupported: unsupported };
    }

    return {
      ok: true,
      dataUrl: dataUrl,
      width: WIDTH * scale,
      height: height * scale,
      encrypted: encrypted,
      unsupported: unsupported,
      bytes: Math.round((dataUrl.length * 3) / 4),
    };
  }

  /**
   * 逐题渲染，返回数组；单题失败不影响其他题。
   */
  function renderAll(quiz, options) {
    const results = [];
    const questions = (quiz && quiz.questions) || [];
    for (const question of questions) {
      let result;
      try {
        result = render(question, options);
      } catch (e) {
        result = { ok: false, reason: 'render-error: ' + (e && e.message) };
      }
      results.push({
        key: question.key,
        num: question.num,
        type: question.type,
        rendered: result,
      });
    }
    return results;
  }

  return {
    render,
    renderAll,
    detectUnsupported,
    constants: { WIDTH, PADDING, FONT_SIZE, LINE_HEIGHT, MAX_HEIGHT, MAX_WIDTH },
  };
})();
