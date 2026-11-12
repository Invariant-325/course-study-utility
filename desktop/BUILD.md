# 本地运行与 Windows 构建

## 环境

需要 Windows x64、Node.js 与 npm。依赖版本以 `package.json` 和 `package-lock.json` 为准，当前锁定 Electron 33.4.11、electron-builder 25.1.8，安装器使用 NSIS。

在仓库根目录运行：

```powershell
cd desktop
npm ci
npm start
```

`npm ci` 会安装锁定依赖并下载 Electron；首次打包还需要下载 NSIS。下载失败时先检查网络和 npm 日志，不要直接更换锁文件或依赖版本。

## 构建安装包

在 `desktop` 目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1
```

脚本会检查依赖，使用 `node_modules/electron/dist` 中的运行时覆盖 `build.electronDist`，执行 electron-builder，并检查中英文语言包、ASAR 中的源码以及 EXE 产品资源。输出位于仓库根目录的 `dist/`，包括 `win-unpacked/` 和 `CourseStudyUtility-<版本>-Setup-x64.exe`。

在普通用户终端构建，不要在受限执行令牌中运行旧版 NSIS 编译器。安装程序的管理员权限要求由现有 NSIS 配置决定。

## 图标、版本资源与签名

如需写入应用图标、产品名和版本资源，将 `CHAOXING_RCEDIT` 指向 `rcedit-x64.exe`。`Build.ps1` 也会尝试从已安装依赖中定位它。

```powershell
$env:CHAOXING_RCEDIT = 'C:\tools\rcedit-x64.exe'
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1
```

`CHAOXING_RCEDIT` 不是启动和打包的必需参数，但缺少它时，EXE 可能保留 Electron 的默认产品名和版本资源。构建日志会给出相应提示。资源写入由 `build/after-pack.cjs` 处理。

当前发布的安装包没有发布者数字签名。写入图标和版本资源不会赋予安装包数字签名。

## 离线运行时与手动打包

`package.json` 的 `build.electronDist` 默认指向 `desktop/vendor/electron/dist`。手动离线构建前，需要在该目录放入与锁文件版本一致的完整 Windows x64 Electron 运行时；仅复制 `electron.exe` 不够。

在依赖和离线运行时均准备好后，可在 `desktop` 目录运行：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist -- --publish never
npm run verify:package
```

`Build.ps1` 使用已安装依赖下的运行时；上述手动命令使用 `build.electronDist` 的默认配置。两种方式均需遵守相同的运行时版本和资源校验要求。

不要使用 `--config.electronLanguages=zh-CN,en-US` 覆盖配置：`package.json` 已用真正的数组配置中英文语言包。启动集成测试时使用干净的 Electron 运行时，`resources/` 中不要遗留历史 `app/` 副本。

## 校验与集成测试

`npm run verify:package` 检查产物中的语言包、ASAR 与源码。通过校验不等于已完成登录、课程读取或真实模型的端到端验证。

现有集成测试入口为 `tests/electron-regression.cjs`：使用独立 `--user-data-dir`、`--no-proxy-server`，设置 `CX_NODE` 为 Node.js 绝对路径，`CX_TEST_PHASE` 按 `write`、`read`、`after-logout` 顺序执行，后两次使用同一配置目录。

`tests/vision-live-smoke.cjs` 是可选的真实模型测试，会使用用户已有配置对自制题目发起请求，可能产生模型 API 费用。不要把带有账号或密钥的测试配置打进安装包或提交到仓库。
