import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const { exports } = loadEnv(['10-log.js', '60-video.js']);
const VideoCtl = exports.VideoCtl;

// 最小可控的 video 替身：统计监听器数量，便于验证不泄漏
function fakeVideo(overrides = {}) {
  const listeners = {};
  const video = {
    playbackRate: 1,
    paused: true,
    ended: false,
    muted: false,
    duration: 100,
    currentTime: 0,
    readyState: 4,
    _listenerCount(type) {
      return (listeners[type] || []).length;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type] || [];
      const index = arr.indexOf(fn);
      if (index >= 0) arr.splice(index, 1);
    },
    play() {
      video.paused = false;
      return Promise.resolve();
    },
    pause() {
      video.paused = true;
    },
    fire(type) {
      for (const fn of (listeners[type] || []).slice()) fn({ type }, video);
    },
    ...overrides,
  };
  return video;
}

const EVENT_TYPES = ['ended', 'pause', 'playing', 'error', 'loadedmetadata', 'timeupdate'];

test('播放：把非 1.0 倍速纠正为 1.0', async () => {
  const video = fakeVideo({ playbackRate: 2 });
  const result = await VideoCtl.play(video);
  assert.equal(result.ok, true);
  assert.equal(video.playbackRate, 1);
});

test('播放：被浏览器拒绝时如实返回失败，不做静音绕过', async () => {
  const video = fakeVideo({
    play() {
      const error = new Error('blocked');
      error.name = 'NotAllowedError';
      return Promise.reject(error);
    },
  });
  const result = await VideoCtl.play(video);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NotAllowedError');
  assert.equal(video.muted, false, '不得擅自静音');
});

test('事件绑定：同一元素重复 attach 不会叠加监听器', () => {
  const video = fakeVideo();
  const cb = {};
  VideoCtl.attach(video, cb);
  const counts = EVENT_TYPES.map((t) => video._listenerCount(t));
  VideoCtl.attach(video, cb);
  assert.deepEqual(
    EVENT_TYPES.map((t) => video._listenerCount(t)),
    counts,
    '重复绑定必须被忽略'
  );
});

test('事件绑定：换视频时解绑旧元素（无监听器泄漏）', () => {
  const first = fakeVideo();
  const second = fakeVideo();
  VideoCtl.attach(first, {});
  VideoCtl.attach(second, {});
  assert.equal(first._listenerCount('ended'), 0, '旧视频必须完全解绑');
  assert.equal(first._listenerCount('timeupdate'), 0);
  assert.equal(second._listenerCount('ended'), 1);
});

test('事件绑定：detach 后不残留监听器', () => {
  const video = fakeVideo();
  VideoCtl.attach(video, {});
  VideoCtl.detach();
  for (const type of EVENT_TYPES) {
    assert.equal(video._listenerCount(type), 0, type + ' 应无残留');
  }
});

test('结束检测：ended 回调只触发一次', () => {
  const video = fakeVideo();
  let endedCount = 0;
  VideoCtl.attach(video, {
    onEnded() {
      endedCount++;
    },
  });
  video.fire('ended');
  video.fire('ended');
  assert.equal(endedCount, 1);
});

test('结束检测：timeupdate 到达末尾时也会触发一次 ended', () => {
  const video = fakeVideo({ duration: 60, currentTime: 59.8 });
  let endedCount = 0;
  VideoCtl.attach(video, {
    onEnded() {
      endedCount++;
    },
  });
  // 绕过 2s 节流：推进系统时间
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    offset = 3000;
    video.fire('timeupdate');
    offset = 6000;
    video.fire('timeupdate');
  } finally {
    Date.now = realNow;
  }
  assert.equal(endedCount, 1);
});

test('暂停回调：ended 状态下的 pause 不再上报（避免误判为弹题）', () => {
  const video = fakeVideo({ ended: true });
  let pauseCount = 0;
  VideoCtl.attach(video, {
    onPause() {
      pauseCount++;
    },
  });
  video.fire('pause');
  assert.equal(pauseCount, 0);
});

test('info：读取播放状态字段', () => {
  const video = fakeVideo({ currentTime: 12.5, duration: 300, paused: false });
  VideoCtl.attach(video, {});
  const info = VideoCtl.info();
  assert.equal(info.currentTime, 12.5);
  assert.equal(info.duration, 300);
  assert.equal(info.paused, false);
  assert.equal(info.playbackRate, 1);
});

test('atEnd：容差 0.5 秒', () => {
  assert.equal(VideoCtl.atEnd(fakeVideo({ duration: 100, currentTime: 99.6 })), true);
  assert.equal(VideoCtl.atEnd(fakeVideo({ duration: 100, currentTime: 99.0 })), false);
  assert.equal(VideoCtl.atEnd(fakeVideo({ duration: NaN, currentTime: 10 })), false);
});
