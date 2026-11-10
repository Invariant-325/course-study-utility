#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build.mjs —— 把 src/*.js 按序拼成一个 Tampermonkey 单文件
// 零依赖，只用 node 内置模块。
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUT_DIR = join(ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'chaoxing-helper.user.js');

// 00-meta.js 是 UserScript 头，必须留在最外层
const META_FILE = '00-meta.js';

const files = readdirSync(SRC)
  .filter((name) => /^\d{2}-.*\.js$/.test(name))
  .sort();

if (!files.length) {
  console.error('src/ 下没有找到源文件');
  process.exit(1);
}
if (files[0] !== META_FILE) {
  console.error('第一个源文件必须是 ' + META_FILE + '，实际是 ' + files[0]);
  process.exit(1);
}

const meta = readFileSync(join(SRC, META_FILE), 'utf8').trimEnd();

const bodyParts = [];
for (const name of files.slice(1)) {
  const code = readFileSync(join(SRC, name), 'utf8').trimEnd();
  bodyParts.push(
    '\n// ===========================================================================\n' +
      '// ' +
      name +
      '\n// ===========================================================================\n' +
      code +
      '\n'
  );
}

const banner =
  '/* 构建产物，请勿直接编辑。源码见 src/，修改后运行 node build.mjs */\n';

const output =
  meta +
  '\n' +
  banner +
  '\n(function () {\n' +
  "  'use strict';\n" +
  bodyParts.join('') +
  '\n})();\n';

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, output, 'utf8');

const bytes = Buffer.byteLength(output, 'utf8');
const lines = output.split('\n').length;
console.log('已生成 ' + OUT_FILE);
console.log('  源文件: ' + files.length + ' 个');
console.log('  体积:   ' + (bytes / 1024).toFixed(1) + ' KB / ' + lines + ' 行');
