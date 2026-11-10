// ---------------------------------------------------------------------------
// quiz-panel.js —— 章节测验页的独立控制面板（阶段 D2）
//
// 为什么单独一个面板：
//   测验页（mooc-ans/work/doHomeWorkNew）不是视频学习页，
//   复用主面板会带出开始/暂停/停止等无意义控件，且容易干扰 D1。
//   因此这里挂一个只含测验功能的小面板，与主 UI 完全独立。
// ---------------------------------------------------------------------------
const QuizPanel = (function () {
  const CSS = [
    ':host{all:initial}',
    '.panel{position:fixed;top:14px;right:14px;width:330px;z-index:2147483000;',
    'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2430;',
    'background:#fff;border:1px solid #d8dee9;border-radius:10px;box-shadow:0 6px 24px rgba(16,24,40,.16);overflow:hidden}',
    '.head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f4f7fc;border-bottom:1px solid #e4e9f2;cursor:move}',
    '.head .title{font-weight:600;flex:1}',
    '.badge{padding:1px 7px;border-radius:9px;font-size:11px;background:#e8edf7;color:#4a5670}',
    '.badge.warn{background:#fff4e2;color:#9a6414}',
    '.badge.ok{background:#e3f6e9;color:#1a7f45}',
    '.body{padding:9px 10px 10px}',
    '.row{display:flex;gap:6px;margin-bottom:3px}',
    '.row .k{color:#7c869b;flex:0 0 74px}',
    '.row .v{flex:1;min-width:0;word-break:break-all}',
    '.msg{margin:5px 0;padding:5px 7px;border-radius:6px;background:#fff4e2;color:#9a6414;display:none;font-size:11px;line-height:1.45}',
    '.msg.show{display:block}',
    '.btns{display:flex;gap:6px;margin:7px 0 4px}',
    '.btns button{flex:1;padding:5px 0;border-radius:6px;border:1px solid #cfd8e6;background:#fff;cursor:pointer;font-size:12px}',
    '.btns button:disabled{opacity:.45;cursor:not-allowed}',
    '.btns button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
    '.btns button.danger{color:#b3261e;border-color:#e6b4b1}',
    '.list{max-height:230px;overflow:auto;margin-top:6px}',
    '.item{padding:5px 6px;border-radius:6px;background:#f8faff;margin-bottom:4px;font-size:11px;line-height:1.45}',
    '.item .n{font-weight:600;color:#33507a}',
    '.item .ans{color:#146b32;font-weight:600}',
    '.item .skip{color:#9a6414}',
    '.item .err{color:#b3261e}',
    '.hint{margin-top:5px;color:#8b93a7;font-size:11px;line-height:1.4}',
  ].join('');

  let host = null;
  let shadow = null;
  let refs = {};
  let unsubscribe = null;

  function el(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'cx-chapter-quiz-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = [
      '<div class="panel" id="panel">',
      '  <div class="head" id="head"><span class="title">章节测验助手</span><span class="badge" id="badge">未分析</span></div>',
      '  <div class="body">',
      '    <div class="row"><span class="k">题目总数</span><span class="v" id="total">—</span></div>',
      '    <div class="row"><span class="k">字体加密</span><span class="v" id="enc">—</span></div>',
      '    <div class="row"><span class="k">已分析</span><span class="v" id="analyzed">0</span></div>',
      '    <div class="row"><span class="k">需人工</span><span class="v" id="manual">0</span></div>',
      '    <div class="row"><span class="k">Token</span><span class="v" id="token">0</span></div>',
      '    <div class="msg" id="msg"></div>',
      '    <div class="btns">',
      '      <button id="analyze" class="primary">分析测验</button>',
      '      <button id="fill">填写答案</button>',
      '      <button id="submit" class="danger">提交</button>',
      '    </div>',
      '    <div class="list" id="list"></div>',
      '    <details class="ai">',
      '      <summary>视觉识别设置（题目加密时需要）</summary>',
      '      <div class="f"><label>启用</label><input type="checkbox" id="vOn" /></div>',
      '      <div class="f"><label>桥接地址</label><input type="text" id="vUrl" placeholder="http://127.0.0.1:8788" /></div>',
      '      <div class="f"><label>令牌</label><input type="text" id="vToken" placeholder="桥接启动时打印" /></div>',
      '      <div class="btns"><button id="vSave">保存</button><button id="vTest">测试连接</button></div>',
      '      <div class="hint" id="vHint">先把截图的题目喂给本地 DSH 视觉会话，再回填建议。</div>',
      '    </details>',
      '    <div class="hint" id="hint">分析只读；填写与提交都必须由你确认。</div>',
      '  </div>',
      '</div>',
    ].join('');
    while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

    refs = {
      badge: el('badge'),
      total: el('total'),
      enc: el('enc'),
      analyzed: el('analyzed'),
      manual: el('manual'),
      token: el('token'),
      msg: el('msg'),
      list: el('list'),
      analyze: el('analyze'),
      fill: el('fill'),
      submit: el('submit'),
      vOn: el('vOn'),
      vUrl: el('vUrl'),
      vToken: el('vToken'),
      vSave: el('vSave'),
      vTest: el('vTest'),
      vHint: el('vHint'),
    };

    el('analyze').addEventListener('click', function () {
      ChapterQuizRunner.analyze();
    });
    el('fill').addEventListener('click', function () {
      ChapterQuizRunner.fillAll({ force: false });
    });
    el('submit').addEventListener('click', function () {
      let ok = true;
      try {
        if (typeof window.confirm === 'function') {
          ok = window.confirm('确认提交这份测验？提交后通常不可修改。');
        }
      } catch (e) {
        ok = true;
      }
      if (ok) ChapterQuizRunner.submit();
    });

    // ---- 视觉设置 ----
    if (refs.vOn) {
      refs.vOn.checked = Config.get('visionEnabled') === true;
      refs.vUrl.value = Config.get('visionBridgeUrl') || '';
      refs.vToken.value = Config.get('visionBridgeToken') || '';

      refs.vOn.addEventListener('change', function () {
        Config.set('visionEnabled', refs.vOn.checked === true);
      });
      refs.vSave.addEventListener('click', function () {
        Config.set('visionBridgeUrl', refs.vUrl.value.trim());
        Config.set('visionBridgeToken', refs.vToken.value.trim());
        if (refs.vHint) refs.vHint.textContent = '视觉设置已保存';
      });
      refs.vTest.addEventListener('click', async function () {
        if (refs.vHint) refs.vHint.textContent = '正在连接…';
        const result = await QuizVision.health();
        if (refs.vHint) {
          refs.vHint.textContent = result.ok
            ? '连接成功；凭据：' + (result.data.credentialSource || '无') + (result.data.hasCredential ? '' : '（缺少 Key）')
            : '连接失败：' + result.error;
        }
      });
    }

    // 拖动
    let drag = null;
    const panel = el('panel');
    el('head').addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      event.preventDefault();
    });
    window.addEventListener('mousemove', function (event) {
      if (!drag) return;
      const rect = panel.getBoundingClientRect();
      const left = Math.max(4, Math.min(event.clientX - drag.dx, window.innerWidth - rect.width - 4));
      const top = Math.max(4, Math.min(event.clientY - drag.dy, window.innerHeight - rect.height - 4));
      panel.style.right = Math.max(4, window.innerWidth - left - rect.width) + 'px';
      panel.style.top = top + 'px';
    });
    window.addEventListener('mouseup', function () {
      drag = null;
    });

    ChapterQuizRunner.setHooks({ onUpdate: render });
    (document.body || document.documentElement).appendChild(host);

    unsubscribe = Log.subscribe(function (record) {
      if (record && (record.level === 'warn' || record.level === 'error')) {
        Log.debug('[测验面板] ' + record.message);
      }
    });

    // 初始解析一次（只读）
    const quiz = ChapterQuizAdapter.parse(document);
    render({
      phase: 'idle',
      total: quiz.count,
      encryptedCount: quiz.encryptedCount,
      analyzedCount: 0,
      manualCount: 0,
      warnings: quiz.warnings,
      items: quiz.questions.map(function (q) {
        return {
          num: q.num,
          typeLabel: q.typeLabel,
          stem: q.stem.slice(0, 70),
          encrypted: q.encrypted,
          status: 'pending',
          letters: [],
          reason: '',
          error: '',
        };
      }),
      ai: null,
      error: '',
    });
  }

  function render(snap) {
    if (!snap || !shadow) return;

    if (refs.total) refs.total.textContent = String(snap.total || 0) + ' 题';
    if (refs.enc) refs.enc.textContent = String(snap.encryptedCount || 0) + ' 题';
    if (refs.analyzed) refs.analyzed.textContent = String(snap.analyzedCount || 0);
    if (refs.manual) refs.manual.textContent = String(snap.manualCount || 0);
    if (refs.token) {
      const ai = snap.ai;
      refs.token.textContent = ai ? String((ai.promptTokens || 0) + (ai.completionTokens || 0)) : '0';
    }

    if (refs.badge) {
      const phase = snap.phase || 'idle';
      refs.badge.textContent =
        phase === 'analyzing' ? '分析中' : phase === 'ready' ? '已分析' : phase === 'submitted' ? '已提交' : phase === 'error' ? '出错' : '未分析';
      refs.badge.className = 'badge' + (phase === 'ready' ? ' ok' : phase === 'error' ? ' warn' : '');
    }

    if (refs.msg) {
      const parts = [];
      if (snap.error) parts.push(snap.error);
      if (snap.warnings && snap.warnings.length) parts.push(snap.warnings.join('；'));
      refs.msg.textContent = parts.join('\n');
      refs.msg.classList.toggle('show', parts.length > 0);
    }

    if (refs.analyze) refs.analyze.disabled = snap.phase === 'analyzing';
    if (refs.fill) refs.fill.disabled = snap.analyzedCount === 0;
    if (refs.submit) refs.submit.disabled = snap.submitted === true;

    if (refs.list) {
      refs.list.textContent = '';
      for (const item of snap.items || []) {
        const row = document.createElement('div');
        row.className = 'item';
        const head = document.createElement('div');
        head.className = 'n';
        head.textContent = '#' + (item.num || '?') + ' ' + (item.typeLabel || '') + (item.encrypted ? ' 🔒' : '');
        row.appendChild(head);

        const body = document.createElement('div');
        if (item.status === 'ok') {
          body.className = 'ans';
          body.textContent = '建议：' + (item.letters || []).join(',') + (item.reason ? ' · ' + item.reason.slice(0, 40) : '');
        } else if (item.status === 'skip') {
          body.className = 'skip';
          body.textContent = '跳过：' + (item.error || '');
        } else if (item.status === 'error' || item.status === 'invalid') {
          body.className = 'err';
          body.textContent = '失败：' + (item.error || '');
        } else {
          body.textContent = '未分析';
        }
        row.appendChild(body);
        refs.list.appendChild(row);
      }
    }
  }

  function unmount() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
  }

  return { mount, unmount, render };
})();
