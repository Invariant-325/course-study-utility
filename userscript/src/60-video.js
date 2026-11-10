// ---------------------------------------------------------------------------
// video.js —— 播放器定位后的绑定、播放与状态读取
// 硬性约束：播放速率恒为 1.0；不做 seek；不静音；不覆盖平台自身的 onXXX。
// ---------------------------------------------------------------------------
const VideoCtl = (function () {
  let boundVideo = null;
  let boundHandlers = null;
  let lastTickAt = 0;

  function atEnd(video) {
    if (!video) return false;
    try {
      if (video.ended) return true;
      const duration = Number(video.duration);
      const current = Number(video.currentTime);
      if (!isFinite(duration) || duration <= 0) return false;
      return current >= duration - 0.5;
    } catch (e) {
      return false;
    }
  }

  function info(video) {
    const target = video || boundVideo;
    if (!target) return null;
    try {
      return {
        currentTime: Number(target.currentTime) || 0,
        duration: Number(target.duration) || 0,
        paused: !!target.paused,
        ended: !!target.ended,
        readyState: Number(target.readyState) || 0,
        // 停滞判定的关键信号：区分"缓冲中"与"真停滞"
        networkState: Number(target.networkState) || 0,
        playbackRate: Number(target.playbackRate) || 1,
        muted: !!target.muted,
      };
    } catch (e) {
      return null;
    }
  }

  function detach() {
    if (!boundVideo || !boundHandlers) {
      boundVideo = null;
      boundHandlers = null;
      return;
    }
    const v = boundVideo;
    const h = boundHandlers;
    // 用同一份引用解绑，避免匿名函数导致的监听器泄漏
    try {
      v.removeEventListener('ended', h.ended);
      v.removeEventListener('pause', h.pause);
      v.removeEventListener('playing', h.playing);
      v.removeEventListener('error', h.error);
      v.removeEventListener('loadedmetadata', h.loadedmetadata);
      v.removeEventListener('timeupdate', h.timeupdate);
    } catch (e) {
      /* ignore */
    }
    boundVideo = null;
    boundHandlers = null;
  }

  function attach(video, callbacks) {
    if (!video || !callbacks) return false;
    if (boundVideo === video && boundHandlers) return true;

    detach();
    boundVideo = video;
    lastTickAt = 0;

    let endedFired = false;

    boundHandlers = {
      ended: function () {
        if (endedFired) return;
        endedFired = true;
        if (callbacks.onEnded) callbacks.onEnded(video);
      },
      pause: function () {
        if (video.ended) return;
        if (callbacks.onPause) callbacks.onPause(video);
      },
      playing: function () {
        endedFired = false;
        if (callbacks.onPlaying) callbacks.onPlaying(video);
      },
      error: function () {
        if (callbacks.onError) callbacks.onError(video, video.error);
      },
      loadedmetadata: function () {
        if (callbacks.onLoaded) callbacks.onLoaded(video);
      },
      timeupdate: function () {
        // timeupdate 约 4Hz，节流到 2s，仅用于进度显示与结束兜底
        const now = Date.now();
        if (now - lastTickAt < 2000) return;
        lastTickAt = now;
        if (atEnd(video)) {
          if (!endedFired) {
            endedFired = true;
            if (callbacks.onEnded) callbacks.onEnded(video);
          }
          return;
        }
        if (callbacks.onTick) callbacks.onTick(video);
      },
    };

    video.addEventListener('ended', boundHandlers.ended);
    video.addEventListener('pause', boundHandlers.pause);
    video.addEventListener('playing', boundHandlers.playing);
    video.addEventListener('error', boundHandlers.error);
    video.addEventListener('loadedmetadata', boundHandlers.loadedmetadata);
    video.addEventListener('timeupdate', boundHandlers.timeupdate);
    return true;
  }

  // 播放：先锁定 1.0 倍速，再调用 play()。被浏览器拒绝时如实上报，不做静音绕过。
  async function play(video) {
    const target = video || boundVideo;
    if (!target) return { ok: false, reason: 'no-video' };

    try {
      if (Number(target.playbackRate) !== 1) {
        target.playbackRate = 1; // 仅纠正为自然速度
      }
    } catch (e) {
      /* 部分播放器包装层会抛错，忽略 */
    }

    try {
      // 已播完的元素先归零会制造成"重播"，这里只在确实未开始时调用
      await target.play();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: (error && error.name) || 'play-rejected',
        message: (error && error.message) || '',
      };
    }
  }

  function pause(video) {
    const target = video || boundVideo;
    if (!target) return false;
    try {
      target.pause();
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    attach,
    detach,
    play,
    pause,
    info,
    atEnd,
    current() {
      return boundVideo;
    },
  };
})();
