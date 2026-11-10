const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
module.exports = async ctx => {
  for (const locale of ['zh-CN','en-US']) {
    if (!fs.existsSync(path.join(ctx.appOutDir,'locales',locale+'.pak'))) throw new Error('Missing locale '+locale);
  }
  if (process.env.CHAOXING_RCEDIT) {
    execFileSync(process.env.CHAOXING_RCEDIT,[path.join(ctx.appOutDir,'CourseStudyUtility.exe'),
      '--set-icon',path.join(ctx.packager.projectDir,'build/icon.ico'),
      '--set-file-version',ctx.packager.appInfo.version,'--set-product-version',ctx.packager.appInfo.version,
      '--set-version-string','ProductName','课程伴学工具','--set-version-string','FileDescription','课程伴学工具',
      '--set-version-string','OriginalFilename','CourseStudyUtility.exe'],{stdio:'inherit'});
  }
};
