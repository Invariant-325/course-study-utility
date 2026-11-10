// ---------------------------------------------------------------------------
// ui.js —— 悬浮控制面板（Shadow DOM 隔离，避免与页面样式冲突）
// 默认停靠右上角，可拖动、可折叠；不覆盖播放器中央控制区。
// ---------------------------------------------------------------------------
const UI = (function () {
  const CSS = [
    ':host{all:initial}',
    '.panel{position:fixed;top:14px;right:14px;width:296px;z-index:2147483000;',
    'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2430;',
    'background:#fff;border:1px solid #d8dee9;border-radius:10px;',
    'box-shadow:0 6px 24px rgba(16,24,40,.16);overflow:hidden;user-select:none}',
    '.panel.collapsed .body{display:none}',
    '.head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f4f7fc;',
    'border-bottom:1px solid #e4e9f2;cursor:move}',
    '.head .title{font-weight:600;font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.badge{padding:1px 7px;border-radius:9px;font-size:11px;background:#e8edf7;color:#4a5670;white-space:nowrap}',
    '.badge.playing{background:#e3f6e9;color:#1a7f45}',
    '.badge.settling,.badge.advancing,.badge.locating{background:#fff4e2;color:#9a6414}',
    '.badge.blocked{background:#fdeaea;color:#b3261e}',
    '.badge.paused{background:#eef0f4;color:#5b6478}',
    '.badge.completed{background:#e3f6e9;color:#1a7f45}',
    '.iconbtn{border:0;background:transparent;cursor:pointer;color:#5b6478;font-size:12px;padding:2px 4px;border-radius:4px}',
    '.iconbtn:hover{background:#e4e9f2}',
    '.body{padding:9px 10px 10px}',
    '.row{display:flex;gap:6px;margin-bottom:4px;align-items:baseline}',
    '.row .k{color:#7c869b;flex:0 0 62px}',
    '.row .v{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.err{margin:6px 0 4px;padding:5px 7px;border-radius:6px;background:#fdeaea;color:#b3261e;display:none;word-break:break-all}',
    '.err.show{display:block}',
    '.await{display:none;margin:6px 0;padding:7px 8px;border-radius:7px;background:#fff4e2;border:1px solid #f0d9ab}',
    '.await.show{display:block}',
    '.await .t{font-weight:600;color:#9a6414;margin-bottom:3px}',
    '.await .m{color:#7a5a20;font-size:11px;line-height:1.5;margin-bottom:5px;word-break:break-all}',
    '.await .btns{margin:0}',
    '.note{margin:6px 0 2px;padding:5px 7px;border-radius:6px;background:#eef4ff;color:#2a4a86;display:none;font-size:11px;line-height:1.5}',
    '.note.show{display:block}',
    '.quiz{display:none;margin:6px 0;padding:8px;border-radius:8px;background:#f7f4ff;border:1px solid #d9ccf5}',
    '.quiz.show{display:block}',
    '.quiz .t{font-weight:600;color:#5b3fa8;margin-bottom:4px}',
    '.quiz .stem{font-size:11px;line-height:1.5;color:#33284f;margin-bottom:5px;max-height:88px;overflow:auto}',
    '.quiz .opt{font-size:11px;line-height:1.45;padding:2px 5px;border-radius:4px;margin-bottom:2px;color:#3a3350}',
    '.quiz .opt.pick{background:#e2f6e6;color:#146b32;font-weight:600}',
    '.quiz .adv{font-size:11px;line-height:1.45;color:#5b6478;margin:4px 0;max-height:80px;overflow:auto;white-space:pre-wrap}',
    '.quiz .adv .bad{color:#b3261e}',
    '.quiz .btns{margin:4px 0 0}',
    '.ai{margin:6px 0 2px;font-size:11px;color:#5b6478}',
    '.ai summary{cursor:pointer;color:#2f6fed}',
    '.ai .f{display:flex;gap:4px;margin-top:4px;align-items:center}',
    '.ai .f label{flex:0 0 66px;color:#7c869b}',
    '.ai .f input[type=text],.ai .f input[type=password],.ai .f select{flex:1;min-width:0;font-size:11px;padding:2px 4px;border:1px solid #cfd8e6;border-radius:4px}',
    '.ai .hint2{color:#8b93a7;margin-top:3px;line-height:1.4}',
    '.btns{display:flex;gap:6px;margin:8px 0 6px}',
    '.btns button{flex:1;padding:5px 0;border-radius:6px;border:1px solid #cfd8e6;background:#fff;cursor:pointer;font-size:12px}',
    '.btns button:hover{background:#f0f4fb}',
    '.btns button:disabled{opacity:.45;cursor:not-allowed}',
    '.btns button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    '.btns button.primary:hover{background:#2a63d4}',
    '.btns button.danger{background:#fff;border-color:#e6b4b1;color:#b3261e}',
    '.toggles{display:flex;gap:10px;align-items:center;margin:6px 0;color:#5b6478;flex-wrap:wrap}',
    '.toggles label{display:flex;gap:4px;align-items:center;cursor:pointer}',
    '.toggles .link{color:#2f6fed;cursor:pointer;text-decoration:underline}',
    '.log{display:none;margin-top:6px;max-height:168px;overflow:auto;background:#0f1420;color:#c8d3e6;',
    'border-radius:6px;padding:6px 7px;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}',
    '.log.show{display:block}',
    '.log .warn{color:#ffd07a}',
    '.log .error{color:#ff9b9b}',
    '.log .debug{color:#8b97ad}',
    '.hint{margin-top:5px;color:#8b93a7;font-size:11px}',
  ].join('');

  const HTML = [
    '<div class="panel" id="panel">',
    '  <div class="head" id="head">',
    '    <span class="title">学习通连播助手</span>',
    '    <span class="badge" id="badge">未启动</span>',
    '    <button class="iconbtn" id="collapse" title="折叠/展开">—</button>',
    '  </div>',
    '  <div class="body">',
    '    <div class="row"><span class="k">课程/节点</span><span class="v" id="job">—</span></div>',
    '    <div class="row"><span class="k">播放状态</span><span class="v" id="play">—</span></div>',
    '    <div class="row"><span class="k">章节进度</span><span class="v" id="chapter">—</span></div>',
    '    <div class="row"><span class="k">已播视频</span><span class="v" id="count">0</span></div>',
    '    <div class="row"><span class="k">平台确认</span><span class="v" id="confirmed">0</span></div>',
    '    <div class="row"><span class="k">待人工确认</span><span class="v" id="pending">0</span></div>',
    '    <div class="row"><span class="k">自动切换</span><span class="v" id="auto">待命</span></div>',
    '    <div class="row"><span class="k">AI 请求</span><span class="v" id="ai">0 次</span></div>',
    '    <div class="err" id="err"></div>',
    '    <div class="note" id="note"></div>',
    '    <div class="await" id="awaitBox">',
    '      <div class="t">视频已播完，平台未确认</div>',
    '      <div class="m" id="awaitMsg"></div>',
    '      <div class="btns">',
    '        <button id="keepWait">继续等待</button>',
    '        <button id="skipRec">跳过并记录</button>',
    '        <button id="stop2" class="danger">停止</button>',
    '      </div>',
    '    </div>',
    '    <div class="quiz" id="quizBox">',
    '      <div class="t" id="quizTitle">检测到弹题</div>',
    '      <div class="stem" id="quizStem"></div>',
    '      <div id="quizOpts"></div>',
    '      <div class="adv" id="quizAdv"></div>',
    '      <div class="btns">',
    '        <button id="qApply">应用建议</button>',
    '        <button id="qSubmit" class="danger">提交</button>',
    '        <button id="qManual">转人工</button>',
    '      </div>',
    '    </div>',
    '    <details class="ai" id="aiBox">',
    '      <summary>AI 设置（弹题用）</summary>',
    '      <div class="f"><label>启用</label><input type="checkbox" id="aiOn" /></div>',
    '      <div class="f"><label>模式</label><select id="aiMode"><option value="proxy">本地代理（推荐）</option><option value="direct">直连</option></select></div>',
    '      <div class="f"><label>代理地址</label><input type="text" id="aiProxyUrl" placeholder="http://127.0.0.1:8787" /></div>',
    '      <div class="f"><label>代理令牌</label><input type="text" id="aiToken" placeholder="代理启动时打印" /></div>',
    '      <div class="f"><label>Base URL</label><input type="text" id="aiBaseUrl" placeholder="https://api.deepseek.com/v1" /></div>',
    '      <div class="f"><label>模型</label><input type="text" id="aiModel" placeholder="deepseek-chat" /></div>',
    '      <div class="f"><label>API Key</label><input type="password" id="aiKey" placeholder="仅存油猴存储" /></div>',
    '      <div class="btns"><button id="aiSave">保存 AI 设置</button></div>',
    '      <div class="hint2" id="aiHint">默认走本地代理，API Key 由代理持有，不进入网页。</div>',
    '    </details>',
    '    <div class="btns">',
    '      <button id="start" class="primary">开始</button>',
    '      <button id="pause">暂停</button>',
    '      <button id="resume">继续</button>',
    '      <button id="stop" class="danger">停止</button>',
    '    </div>',
    '    <div class="toggles">',
    '      <label><input type="checkbox" id="debug" /> 调试日志</label>',
    '      <span class="link" id="diagnose">诊断导出</span>',
    '      <span class="link" id="clearpos">复位面板</span>',
    '    </div>',
    '    <div class="log" id="log"></div>',
    '    <div class="hint" id="hint">1.0 倍速 · 不改进度 · 不绕过检测</div>',
    '  </div>',
    '</div>',
  ].join('');

  let host = null;
  let shadow = null;
  let refs = {};
  let unsubscribe = null;
  let logCount = 0;
  let aiRequests = 0;
  let lastChapterRefresh = 0;
  let chapterText = '—';
  let dragState = null;

  function el(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

  function appendLogRecord(record) {
    const box = el('log');
    if (!box) return;
    logCount++;
    if (logCount > 200) {
      box.removeChild(box.firstChild);
    }
    const line = document.createElement('div');
    line.className = record.level;
    line.textContent = record.time + ' ' + record.message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function refreshLog() {
    const box = el('log');
    if (!box) return;
    box.textContent = '';
    logCount = 0;
    for (const record of Log.recent(120)) appendLogRecord(record);
  }

  function setBadge(text, kind) {
    const badge = el('badge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'badge ' + (kind || '');
  }

  function update(snapshot) {
    if (!snapshot || !shadow) return;

    const label = snapshot.stateLabel || snapshot.state || '—';
    setBadge(label, snapshot.state);

    const jobText = snapshot.jobTitle
      ? snapshot.jobTitle + (snapshot.jobType ? '（' + snapshot.jobType + '）' : '')
      : '—';
    if (refs.job) refs.job.textContent = jobText;

    const video = snapshot.video;
    let playText = '—';
    if (video) {
      const cur = video.currentTime || 0;
      const dur = video.duration || 0;
      playText =
        (video.ended ? '已结束' : video.paused ? '暂停' : '播放中') +
        ' · ' +
        (Number(video.playbackRate) || 1) +
        'x · ' +
        (dur > 0 ? fmtTime(cur) + '/' + fmtTime(dur) : fmtTime(cur));
    }
    if (refs.play) refs.play.textContent = playText;

    if (refs.count) refs.count.textContent = String(snapshot.playedCount || 0);
    if (refs.confirmed) refs.confirmed.textContent = String(snapshot.confirmedCount || 0);
    if (refs.pending) refs.pending.textContent = String(snapshot.pendingCount || 0);
    if (refs.ai) refs.ai.textContent = aiRequests + ' 次';

    // awaitingConfirm 的专用操作区
    const awaiting = snapshot.state === 'awaitingConfirm';
    if (refs.awaitBox) refs.awaitBox.classList.toggle('show', awaiting);
    if (awaiting && refs.awaitMsg) {
      const waitedSec = snapshot.awaitingSince ? Math.round((Date.now() - snapshot.awaitingSince) / 1000) : 0;
      refs.awaitMsg.textContent =
        (snapshot.jobTitle ? '任务：' + snapshot.jobTitle + '；' : '') +
        '已等待 ' + waitedSec + ' 秒，平台仍未标记完成。已尝试等待 ' +
        (snapshot.awaitingTries || 0) + ' 次。跳过不计入完成。';
    }

    // 完成度说明（视频完成 ≠ 整门课程完成）
    if (refs.note) {
      let noteText = '';
      const completion = snapshot.completion;
      if (snapshot.state === 'completed' && completion) {
        noteText = '视频任务已全部得到平台确认';
        if (completion.pendingOthers && completion.pendingOthers > 0) {
          noteText += '；但仍有 ' + completion.pendingOthers + ' 个非视频任务（如章节测验）未处理，整门课程尚未完成';
        }
      } else if (snapshot.state === 'needsReview' && completion && completion.reasons.length) {
        noteText = '无法确认完成：' + completion.reasons.join('；');
      }
      refs.note.textContent = noteText;
      refs.note.classList.toggle('show', !!noteText);
    }

    if (refs.auto) {
      if (snapshot.state === 'blocked') refs.auto.textContent = '已停止（需人工）';
      else if (snapshot.state === 'paused') refs.auto.textContent = '已暂停';
      else if (snapshot.state === 'completed') refs.auto.textContent = '课程完成';
      else if (snapshot.state === 'stopped') refs.auto.textContent = '已停止';
      else if (snapshot.running) refs.auto.textContent = '自动切换中';
      else refs.auto.textContent = '待命';
    }

    if (refs.err) {
      if (snapshot.lastError) {
        refs.err.textContent = '最近错误：' + snapshot.lastError;
        refs.err.classList.add('show');
      } else {
        refs.err.textContent = '';
        refs.err.classList.remove('show');
      }
    }

    const state = snapshot.state;
    if (refs.start) refs.start.disabled = snapshot.running || state === 'playing';
    if (refs.pause) refs.pause.disabled = !snapshot.running;
    // quizWait 也要能点「继续」：那是结束弹题并交还播放的出口
    if (refs.resume) refs.resume.disabled = state !== 'paused' && state !== 'quizWait';
    if (refs.stop) refs.stop.disabled = state === 'stopped' || state === 'completed';

    // 章节进度：节流刷新，避免高频读取 DOM
    const now = Date.now();
    if (now - lastChapterRefresh > 2500) {
      lastChapterRefresh = now;
      refreshChapter();
    }

    renderQuiz(snapshot.quiz, state);
  }

  function refreshChapter() {
    if (!refs.chapter) return;
    try {
      const catalog = CourseTree.catalogEntries();
      if (!catalog.items.length) {
        refs.chapter.textContent = '未识别目录';
        return;
      }
      let activeIndex = -1;
      for (let i = 0; i < catalog.items.length; i++) {
        const node = catalog.items[i];
        const active =
          (node.classList && node.classList.contains(SEL.catalogActiveClass)) ||
          !!node.querySelector('.' + SEL.catalogActiveClass);
        if (active) {
          activeIndex = i;
          break;
        }
      }
      chapterText =
        activeIndex >= 0
          ? '第 ' + (activeIndex + 1) + ' / ' + catalog.items.length + ' 节'
          : '共 ' + catalog.items.length + ' 节（未定位当前）';
      refs.chapter.textContent = chapterText;
    } catch (e) {
      refs.chapter.textContent = '读取失败';
    }
  }

  function fmtTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // 弹题卡片（阶段 D1）
  function renderQuiz(quiz, state) {
    if (!refs.quizBox) return;
    const show = state === 'quizWait' && quiz && quiz.phase && quiz.phase !== 'idle';
    refs.quizBox.classList.toggle('show', !!show);
    if (!show) return;

    const question = quiz.question;
    if (refs.quizTitle) {
      refs.quizTitle.textContent = question
        ? '检测到弹题 · ' + (question.typeLabel || '')
        : '弹题处理中';
    }
    if (refs.quizStem) {
      refs.quizStem.textContent = question ? question.stem : quiz.error || '';
    }

    if (refs.quizOpts) {
      refs.quizOpts.textContent = '';
      if (question) {
        const pick = new Set((quiz.suggestion && quiz.suggestion.letters) || []);
        for (const option of question.options) {
          const row = document.createElement('div');
          row.className = 'opt' + (pick.has(option.letter) ? ' pick' : '');
          row.textContent =
            option.letter + '. ' + option.text + (pick.has(option.letter) ? '   ← 建议' : '');
          refs.quizOpts.appendChild(row);
        }
      }
    }

    if (refs.quizAdv) {
      const lines = [];
      const suggestion = quiz.suggestion;
      if (suggestion) {
        lines.push(
          '建议：' + suggestion.letters.join(',') +
            '（置信度 ' + Math.round((suggestion.confidence || 0) * 100) + '%）'
        );
        if (suggestion.reason) lines.push('理由：' + suggestion.reason);
        if (suggestion.uncertain) lines.push('⚠ 模型自述不确定，请人工核对后再提交');
      }
      if (quiz.error) lines.push('⚠ ' + quiz.error);
      const ai = quiz.ai;
      if (ai) {
        lines.push(
          'AI 请求 ' + ai.requests + ' 次 / 失败 ' + ai.failures +
            ' / token ' + (ai.promptTokens + ai.completionTokens)
        );
      }
      refs.quizAdv.textContent = lines.join('\n');
    }

    if (refs.qApply) refs.qApply.disabled = !quiz.suggestion;
    if (refs.qSubmit) refs.qSubmit.disabled = !question || quiz.submitted === true;
  }

  function applyPosition() {
    const panel = el('panel');
    if (!panel) return;
    const pos = Config.get('panelPos');
    if (pos && typeof pos.right === 'number' && typeof pos.top === 'number') {
      panel.style.right = Math.max(0, pos.right) + 'px';
      panel.style.top = Math.max(0, pos.top) + 'px';
    }
  }

  // AI 设置（阶段 D1）
  function initAiSettings() {
    if (!refs.aiOn) return;

    refs.aiOn.checked = Config.get('llmEnabled') === true;
    refs.aiMode.value = Config.get('llmMode') === 'direct' ? 'direct' : 'proxy';
    refs.aiProxyUrl.value = Config.get('llmProxyUrl') || '';
    refs.aiToken.value = Config.get('llmProxyToken') || '';
    refs.aiBaseUrl.value = Config.get('llmBaseUrl') || '';
    refs.aiModel.value = Config.get('llmModel') || '';

    if (refs.aiHint) {
      refs.aiHint.textContent = Config.hasGM()
        ? '默认走本地代理：API Key 由代理持有，不进入网页。直连模式需自己在脚本头追加 @connect。'
        : '当前没有油猴存储：禁止保存 API Key，只能用本地代理模式。';
    }

    refs.aiOn.addEventListener('change', function () {
      Config.set('llmEnabled', refs.aiOn.checked === true);
      Log.info('AI 弹题：' + (refs.aiOn.checked ? '已开启' : '已关闭'));
    });

    if (refs.aiSave) {
      refs.aiSave.addEventListener('click', function () {
        Config.set('llmMode', refs.aiMode.value === 'direct' ? 'direct' : 'proxy');
        Config.set('llmProxyUrl', refs.aiProxyUrl.value.trim());
        Config.set('llmProxyToken', refs.aiToken.value.trim());
        Config.set('llmBaseUrl', refs.aiBaseUrl.value.trim());
        Config.set('llmModel', refs.aiModel.value.trim());
        const key = refs.aiKey.value.trim();
        if (key && !Config.set('llmApiKey', key)) {
          Log.warn('API Key 未保存：请改用本地代理模式');
        }
        Log.info('AI 设置已保存（模式：' + Config.get('llmMode') + '）');
      });
    }
  }

  function bindDrag() {    const head = el('head');
    const panel = el('panel');
    if (!head || !panel) return;

    head.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      event.preventDefault();
    });

    window.addEventListener('mousemove', function (event) {
      if (!dragState) return;
      const rect = panel.getBoundingClientRect();
      const width = rect.width || 296;
      const height = rect.height || 200;
      let left = event.clientX - dragState.offsetX;
      let top = event.clientY - dragState.offsetY;
      left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - height - 4));
      panel.style.right = Math.max(4, window.innerWidth - left - width) + 'px';
      panel.style.top = top + 'px';
    });

    window.addEventListener('mouseup', function () {
      if (!dragState) return;
      dragState = null;
      const rect = panel.getBoundingClientRect();
      Config.set('panelPos', {
        right: Math.round(Math.max(0, window.innerWidth - rect.right)),
        top: Math.round(Math.max(0, rect.top)),
      });
    });
  }

  function showDiagnose() {
    let data = null;
    try {
      data = Runner.diagnose();
    } catch (e) {
      Log.error('诊断失败：' + (e && e.message));
      return;
    }
    const text = JSON.stringify(data, null, 2);
    // 打印到控制台，并尝试复制到剪贴板，便于贴给我做选择器适配
    console.log('[学习通助手] 诊断导出\n' + text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            Log.info('诊断信息已复制到剪贴板，可直接粘贴');
          },
          function () {
            Log.warn('复制失败，请从控制台复制诊断 JSON');
          }
        );
      } else {
        Log.warn('剪贴板不可用，请从控制台复制诊断 JSON');
      }
    } catch (e) {
      Log.warn('复制异常，请从控制台复制诊断 JSON');
    }
    const box = el('log');
    if (box) {
      box.classList.add('show');
      box.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…（完整内容见控制台）' : text;
    }
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'cx-natural-watch-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = HTML;
    while (wrapper.firstChild) shadow.appendChild(wrapper.firstChild);

    refs = {
      job: el('job'),
      play: el('play'),
      chapter: el('chapter'),
      count: el('count'),
      confirmed: el('confirmed'),
      pending: el('pending'),
      auto: el('auto'),
      ai: el('ai'),
      err: el('err'),
      note: el('note'),
      awaitBox: el('awaitBox'),
      awaitMsg: el('awaitMsg'),
      keepWait: el('keepWait'),
      skipRec: el('skipRec'),
      stop2: el('stop2'),
      quizBox: el('quizBox'),
      quizTitle: el('quizTitle'),
      quizStem: el('quizStem'),
      quizOpts: el('quizOpts'),
      quizAdv: el('quizAdv'),
      qApply: el('qApply'),
      qSubmit: el('qSubmit'),
      qManual: el('qManual'),
      aiOn: el('aiOn'),
      aiMode: el('aiMode'),
      aiProxyUrl: el('aiProxyUrl'),
      aiToken: el('aiToken'),
      aiBaseUrl: el('aiBaseUrl'),
      aiModel: el('aiModel'),
      aiKey: el('aiKey'),
      aiSave: el('aiSave'),
      aiHint: el('aiHint'),
      start: el('start'),
      pause: el('pause'),
      resume: el('resume'),
      stop: el('stop'),
      debug: el('debug'),
      log: el('log'),
    };

    applyPosition();
    if (Config.get('panelCollapsed')) el('panel').classList.add('collapsed');

    el('start').addEventListener('click', function () {
      Runner.start();
    });
    el('pause').addEventListener('click', function () {
      Runner.pause();
    });
    el('resume').addEventListener('click', function () {
      Runner.resume();
    });
    el('stop').addEventListener('click', function () {
      Runner.stop();
    });

    if (refs.keepWait) {
      refs.keepWait.addEventListener('click', function () {
        Runner.keepWaiting();
      });
    }
    if (refs.skipRec) {
      refs.skipRec.addEventListener('click', function () {
        Runner.skipAwaiting();
      });
    }
    if (refs.stop2) {
      refs.stop2.addEventListener('click', function () {
        Runner.stop();
      });
    }

    // ---- 弹题操作 ----
    if (refs.qApply) {
      refs.qApply.addEventListener('click', function () {
        Runner.applyQuizSuggestion();
      });
    }
    if (refs.qSubmit) {
      refs.qSubmit.addEventListener('click', function () {
        // 提交有副作用：必须再确认一次
        let confirmed = true;
        try {
          if (typeof window.confirm === 'function') {
            confirmed = window.confirm('确认提交该题答案？提交后由平台判定。');
          }
        } catch (e) {
          confirmed = true;
        }
        if (confirmed) Runner.submitQuiz();
      });
    }
    if (refs.qManual) {
      refs.qManual.addEventListener('click', function () {
        Runner.dismissQuiz();
      });
    }

    initAiSettings();

    el('collapse').addEventListener('click', function () {
      const panel = el('panel');
      panel.classList.toggle('collapsed');
      Config.set('panelCollapsed', panel.classList.contains('collapsed'));
    });

    if (refs.debug) {
      refs.debug.checked = Config.get('debugLog') === true;
      refs.debug.addEventListener('change', function () {
        Config.set('debugLog', refs.debug.checked === true);
        Log.info('调试日志：' + (refs.debug.checked ? '已开启' : '已关闭'));
      });
    }

    el('diagnose').addEventListener('click', showDiagnose);
    el('clearpos').addEventListener('click', function () {
      Config.set('panelPos', null);
      const panel = el('panel');
      panel.style.right = '14px';
      panel.style.top = '14px';
      Log.info('面板位置已复位');
    });

    // 日志开关：调试日志按钮同时控制日志区显示
    if (refs.debug) {
      refs.debug.addEventListener('change', function () {
        if (refs.log) refs.log.classList.toggle('show', refs.debug.checked === true);
      });
      if (refs.log) refs.log.classList.toggle('show', refs.debug.checked === true);
    }

    bindDrag();
    refreshLog();
    unsubscribe = Log.subscribe(appendLogRecord);

    (document.body || document.documentElement).appendChild(host);
    Log.info('面板已挂载');
  }

  return {
    mount,
    update,
    setAiRequests(count) {
      aiRequests = Number(count) || 0;
      if (refs.ai) refs.ai.textContent = aiRequests + ' 次';
    },
    unmount() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      shadow = null;
    },
    element() {
      return host;
    },
  };
})();
