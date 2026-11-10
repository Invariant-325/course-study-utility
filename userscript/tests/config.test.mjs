import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from './harness.mjs';

const { exports, window } = loadEnv(['10-log.js', '20-config.js']);
const Config = exports.Config;

test('配置：加载后倍速恒为 1.0', () => {
  Config.load();
  assert.equal(Config.get('playbackRate'), 1);
});

test('配置：拒绝写入非 1.0 倍速', () => {
  Config.load();
  const result = Config.set('playbackRate', 2);
  assert.equal(result, false);
  assert.equal(Config.get('playbackRate'), 1, '写被拒绝后仍是 1.0');
});

test('配置：普通项可以写入并读回', () => {
  Config.load();
  Config.set('settleTimeoutMs', 5000);
  assert.equal(Config.get('settleTimeoutMs'), 5000);
});

test('配置：持久化到 localStorage（无油猴环境时的降级路径）', () => {
  Config.load();
  Config.set('debugLog', true);
  const raw = window.localStorage.getItem('cxNaturalWatch:cfg.debugLog');
  assert.equal(raw, 'true');
});

test('配置：断点保存与读取', () => {
  Config.load();
  Config.saveCursor({ jobKey: 'd0#2', jobTitle: '第一章 视频' });
  const cursor = Config.readCursor();
  assert.equal(cursor.jobKey, 'd0#2');
  assert.equal(cursor.jobTitle, '第一章 视频');
  assert.ok(cursor.savedAt > 0);
});

test('配置：清除断点', () => {
  Config.load();
  Config.saveCursor({ jobKey: 'x', jobTitle: 'y' });
  Config.clearCursor();
  assert.equal(Config.readCursor(), null);
});

test('配置：默认不自动开始（避免打开页面就动别人的课）', () => {
  Config.load();
  assert.equal(Config.get('autoStart'), false);
});
