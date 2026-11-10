const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const dir = path.resolve(__dirname, '../../dist/win-unpacked');
for (const f of ['CourseStudyUtility.exe', 'locales/zh-CN.pak', 'locales/en-US.pak', 'resources/app.asar']) {
  if (!fs.existsSync(path.join(dir, f))) throw new Error('Missing: ' + f);
}
const archive = path.join(dir, 'resources/app.asar');
for (const f of ['main.js','preload.js','ui/index.html','ui/app.js','userscript/chaoxing-helper.user.js']) {
  const content = asar.extractFile(archive, f);
  if (!content.length || !content.equals(fs.readFileSync(path.resolve(__dirname, '..', f)))) throw new Error('Archive mismatch: ' + f);
}
if (asar.listPackage(archive).some(f => /\.log$/i.test(f))) throw new Error('Logs in package');
console.log('PASS: executable, locales, ASAR sources, no packaged logs');
