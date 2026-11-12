// ---------------------------------------------------------------------------
// state.js —— 纯状态机（不依赖 DOM，可单元测试）
// 非法转移一律被拒绝并记录，不静默吞掉。
//
// 关键约束（来自 P0-3/P0-4）：
//   - completed 只能由 runner 在 verdict === 'complete' 时进入
//   - settling 超时只能进入 awaitingConfirm，绝不能直接 advancing
//   - awaitingConfirm 是可恢复异常态，不是成功态
// ---------------------------------------------------------------------------
const StateMachine = (function () {
  const TRANSITIONS = {
    idle: ['locating', 'stopped'],
    locating: ['quizWait', 'playing', 'settling', 'advancing', 'blocked', 'needsReview', 'paused', 'stopped', 'awaitingConfirm'],
    playing: ['settling', 'paused', 'blocked', 'stopped', 'locating', 'quizWait', 'needsReview'],
    settling: ['advancing', 'awaitingConfirm', 'blocked', 'paused', 'stopped'],
    awaitingConfirm: ['advancing', 'settling', 'locating', 'blocked', 'paused', 'stopped', 'needsReview'],
    // advancing 允许 quizWait：连播推进途中遇到本节未完成的章节测验，
    // 需要停在测验上做完再继续（见 80-runner 的 processPendingQuiz）
    advancing: [
      'locating',
      'playing',
      'blocked',
      'needsReview',
      'paused',
      'stopped',
      'awaitingConfirm',
      'completed',
      'quizWait',
    ],
    quizWait: ['playing', 'paused', 'blocked', 'stopped', 'advancing', 'locating', 'awaitingConfirm'],
    paused: ['locating', 'stopped', 'blocked'],
    blocked: ['locating', 'paused', 'stopped'],
    needsReview: ['locating', 'paused', 'stopped'],
    completed: ['locating', 'stopped'],
    stopped: ['locating'],
  };

  const LABELS = {
    idle: '未启动',
    locating: '定位任务点',
    playing: '播放中',
    settling: '等待平台记录完成',
    awaitingConfirm: '视频已播完，平台未确认',
    advancing: '切换下一个',
    quizWait: '弹题待处理',
    paused: '已暂停',
    blocked: '需要人工处理',
    needsReview: '无法确认完成',
    completed: '视频任务已完成',
    stopped: '已停止',
  };

  function create(onChange) {
    let state = 'idle';
    let enteredAt = Date.now();
    const transitions = [];
    let blockedReason = '';
    let noteReason = '';

    function canGo(next) {
      const allowed = TRANSITIONS[state];
      return !!allowed && allowed.indexOf(next) !== -1;
    }

    function go(next, reason) {
      if (next === state) return false;
      if (!canGo(next)) {
        if (typeof console !== 'undefined') {
          console.warn('[状态机] 拒绝非法转移 ' + state + ' -> ' + next + (reason ? ' (' + reason + ')' : ''));
        }
        return false;
      }
      const previous = state;
      state = next;
      enteredAt = Date.now();
      if (next === 'blocked') blockedReason = reason || '';
      else if (next !== 'idle') blockedReason = '';
      if (next === 'awaitingConfirm' || next === 'needsReview') noteReason = reason || '';
      transitions.push({ from: previous, to: next, at: enteredAt, reason: reason || '' });
      if (transitions.length > 200) transitions.splice(0, transitions.length - 200);
      if (onChange) {
        try {
          onChange(next, previous, reason || '');
        } catch (e) {
          /* 回调异常不得影响状态机 */
        }
      }
      return true;
    }

    return {
      go: go,
      canGo: canGo,
      state() {
        return state;
      },
      label(s) {
        return LABELS[s || state] || s || state;
      },
      enteredAt() {
        return enteredAt;
      },
      blockedReason() {
        return blockedReason;
      },
      noteReason() {
        return noteReason;
      },
      transitions() {
        return transitions.slice();
      },
      reset() {
        state = 'idle';
        enteredAt = Date.now();
        blockedReason = '';
        noteReason = '';
        transitions.length = 0;
      },
      isRunningState() {
        return ['locating', 'playing', 'settling', 'advancing'].indexOf(state) !== -1;
      },
      isHoldingState() {
        return ['paused', 'blocked', 'awaitingConfirm', 'needsReview'].indexOf(state) !== -1;
      },
    };
  }

  return { create, TRANSITIONS, LABELS };
})();
