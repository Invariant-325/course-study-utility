import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const { exports } = loadEnv(['10-log.js', '70-state.js']);
const SM = exports.StateMachine;

test('状态机：初始为 idle，正常链路可推进', () => {
  const sm = SM.create();
  assert.equal(sm.state(), 'idle');
  assert.equal(sm.go('locating', 'begin'), true);
  assert.equal(sm.go('playing', 'play-started'), true);
  assert.equal(sm.go('settling', 'video-ended'), true);
  assert.equal(sm.go('advancing', 'advance'), true);
  assert.equal(sm.go('locating', 'next'), true);
});

test('状态机：拒绝非法转移且状态不变', () => {
  const sm = SM.create();
  assert.equal(sm.go('playing'), false, 'idle 不能直接到 playing');
  assert.equal(sm.state(), 'idle');
  assert.equal(sm.go('settling'), false, 'idle 不能直接到 settling');
  assert.equal(sm.state(), 'idle');
});

test('状态机：playing 允许意外暂停与阻塞', () => {
  const sm = SM.create();
  sm.go('locating');
  sm.go('playing');
  assert.equal(sm.go('blocked', 'play-rejected'), true);
  assert.equal(sm.state(), 'blocked');
  assert.equal(sm.blockedReason(), 'play-rejected');
});

test('状态机：blocked 可以回到 locating（人工处理后重试）', () => {
  const sm = SM.create();
  sm.go('locating');
  sm.go('blocked', 'x');
  assert.equal(sm.go('locating', 'retry'), true);
  assert.equal(sm.state(), 'locating');
});

test('状态机：settling 可以直接 blocked（未到末尾）', () => {
  const sm = SM.create();
  sm.go('locating');
  sm.go('playing');
  sm.go('settling');
  assert.equal(sm.go('blocked', 'not-at-end'), true);
});

test('状态机：停止后可以重新开始', () => {
  const sm = SM.create();
  sm.go('stopped');
  assert.equal(sm.go('locating'), true);
});

test('状态机：暂停只能从运行态进入', () => {
  const sm = SM.create();
  assert.equal(sm.go('paused'), false, 'idle 不能暂停');
  sm.go('locating');
  sm.go('playing');
  assert.equal(sm.go('paused', 'user-pause'), true);
  assert.equal(sm.go('locating'), true, '暂停后可以继续');
});

test('状态机：onChange 回调收到前后状态', () => {
  const seen = [];
  const sm = SM.create((next, previous, reason) => seen.push([previous, next, reason]));
  sm.go('locating', 'begin');
  sm.go('playing', 'play-started');
  assert.deepEqual(seen, [
    ['idle', 'locating', 'begin'],
    ['locating', 'playing', 'play-started'],
  ]);
});

test('状态机：同状态转移被忽略', () => {
  const sm = SM.create();
  sm.go('locating');
  assert.equal(sm.go('locating'), false);
  assert.equal(sm.transitions().length, 1);
});
