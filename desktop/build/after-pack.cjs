const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
module.exports = async function (ctx) {
  const dir = ctx.appOutDir;
  for (const locale of ['zh-CN', 'en-US']) {
    if (!fs.existsSync(path.join(dir, 'locales', locale + '.pak'))) throw new Error('Missing locale: ' + locale);
  }
  const tool = process.env.CHAOXING_RCEDIT;
  if (tool) {
    execFileSync(tool, [path.join(dir, 'ChaoxingHelper.exe'), '--set-icon', path.join(ctx.packager.projectDir, 'build', 'icon.ico'), '--set-file-version', '0.1.1', '--set-product-version', '0.1.1', '--set-version-string', 'ProductName', '学习通助手', '--set-version-string', 'FileDescription', '学习通助手', '--set-version-string', 'OriginalFilename', 'ChaoxingHelper.exe'], { stdio: 'inherit' });
  }
};
