const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

// EXE 版本资源必须是纯数字，0.2.0-beta.2 这类要归一成 0.2.0
function numericVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m[1] + '.' + m[2] + '.' + m[3] : '0.0.0';
}

module.exports = async ctx => {
  // A reused local Electron runtime can contain an old resources/app tree.
  // Remove it only inside this resolved build output; app.asar is authoritative.
  const output=fs.realpathSync(ctx.appOutDir);
  const legacy=path.join(output,'resources','app');
  if(fs.existsSync(legacy)){
    const resolved=fs.realpathSync(legacy);
    if(!resolved.startsWith(output+path.sep))throw new Error('Legacy app escaped build output');
    fs.rmSync(legacy,{recursive:true,force:true});
  }
  for (const locale of ['zh-CN','en-US']) {
    if (!fs.existsSync(path.join(ctx.appOutDir,'locales',locale+'.pak'))) throw new Error('Missing locale '+locale);
  }
  if (process.env.CHAOXING_RCEDIT) {
    const v = numericVersion(ctx.packager.appInfo.version);
    execFileSync(process.env.CHAOXING_RCEDIT,[path.join(ctx.appOutDir,'CourseStudyUtility.exe'),
      '--set-icon',path.join(ctx.packager.projectDir,'build/icon.ico'),
      '--set-file-version',v,'--set-product-version',v,
      '--set-version-string','ProductName','课程伴学工具',
      '--set-version-string','FileDescription','课程伴学工具',
      '--set-version-string','OriginalFilename','CourseStudyUtility.exe'],{stdio:'inherit'});
  }
};
