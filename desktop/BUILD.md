# 构建说明

需要 Windows x64、Node.js 与 npm。

1. 在此源码目录运行 `npm ci`，安装锁定版本依赖并下载 Electron。
2. 执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1`。
3. 构建结果位于源码目录相邻的 `dist` 目录；脚本会检查中英文语言包和 ASAR 中的源码。

首次构建需要下载依赖及 NSIS；请在普通用户终端构建，不要在受限执行令牌中运行旧版 NSIS 编译器。`CHAOXING_RCEDIT` 不是必需参数；如需重做 EXE 图标与版本资源，可将 `CHAOXING_RCEDIT`设为 rcedit-x64.exe 的路径。当前交付的二进制已经写入图标、中文产品名和当前 package.json 版本。

签名：当前为本地自用构建，没有发布者数字签名。

不要使用 `--config.electronLanguages=zh-CN,en-US`；package.json 已使用真正数组，只保留中英文。

本地集成测试：使用干净 Electron（resources 目录不要放历史 app/ 副本）运行 tests/electron-regression.cjs，指定独立 --user-data-dir、--no-proxy-server，设置 CX_NODE 为 Node.js 绝对路径，CX_TEST_PHASE 按 write/read/after-logout 依次执行；后两次使用同一配置目录。tests/vision-live-smoke.cjs 是可选的真实模型测试，会使用用户已有配置对自制题目发起一次请求。
