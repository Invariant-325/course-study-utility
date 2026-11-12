const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const dir = path.resolve(__dirname, '../../dist/win-unpacked');
for (const f of ['CourseStudyUtility.exe', 'locales/zh-CN.pak', 'locales/en-US.pak', 'resources/app.asar']) {
  if (!fs.existsSync(path.join(dir, f))) throw new Error('Missing: ' + f);
}
const archive = path.join(dir, 'resources/app.asar');
if(fs.existsSync(path.join(dir,'resources/app')))throw new Error('Legacy unpacked app residue');
// 新界面把脚本拆到了 ui/scripts、样式拆到了 ui/styles，这里按实际结构校验。
// 注意：Windows 上 asar.extractFile 只认反斜杠路径，用 / 会报 not found。
for (const f of [
  'question-capture.cjs','chapter-quiz-bridge.cjs','catalog-progress.cjs','manual-quiz.cjs','playback-controller.cjs','sleep-guard.cjs','page-catalog.cjs','chapter-title.cjs','course-portal.cjs','browser-policy.cjs','login-session.cjs','course-browser.cjs','frame-bridge.cjs',
  'main.js','preload.js',
  'ui/index.html',
  'ui/scripts/study-plan.js','ui/scripts/app.js','ui/scripts/theme.js','ui/scripts/layout.js',
  'ui/styles/tokens.css','ui/styles/base.css','ui/styles/layout.css','ui/styles/components.css','ui/styles/pages.css','ui/styles/product.css',
  'ui/assets/logo.png',
  'userscript/chaoxing-helper.user.js',
]) {
  const inArchive = f.split('/').join(path.sep);
  const content = asar.extractFile(archive, inArchive);
  const onDisk = fs.readFileSync(path.resolve(__dirname, '..', f));
  if (!content.length || !content.equals(onDisk)) throw new Error('Archive mismatch: ' + f);
}
if (asar.listPackage(archive).some(f => /\.log$/i.test(f))) throw new Error('Logs in package');
console.log('PASS: executable, locales, ASAR sources, no packaged logs');
