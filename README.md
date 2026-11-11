# 课程伴学工具

一个兼容学习通（超星平台）的 Windows 课程辅助工具。把课程页面、播放控制和 AI 题目识别放在同一个窗口里，也保留了可单独使用的 Tampermonkey 脚本。

[下载最新版本](https://github.com/Invariant-325/course-study-utility/releases/latest) · [更新日志](CHANGELOG.md) · [安装与更新](docs/installation-and-updates.md)

**开发预览：[0.2.0 Beta 4](https://github.com/Invariant-325/course-study-utility/releases/tag/v0.2.0-beta.4)**。0.2.0 系列按 Beta 版本迭代，正式版本仍为 **0.1.9**。

本项目由个人独立维护，**不是学习通或超星官方产品**，与超星平台没有隶属、授权、合作或背书关系。相关名称仅用于说明兼容性，商标及其他权利归各自权利人所有。

## 功能

- 课程列表导航、登录状态保存、网页后退与刷新。
- 视频自然播放、任务状态跟踪和章节切换。
- 通过 AI 视觉识别章节测验题目，显示并填写答案。
- 分别控制章节测验的自动做题和自动提交。
- 夜间模式：网页静音，倒计时 30 秒后关闭显示器。

**夜间模式会同时开启自动做题和自动提交。** 新配置下这两个开关默认关闭；已有配置会保留。它们针对章节测验，视频内弹题仍沿用原来的处理逻辑。

## 安装与使用

1. 在 [Releases](https://github.com/Invariant-325/course-study-utility/releases) 下载 Windows x64 的 `Setup-x64.exe`。
2. 正常退出旧版，再运行安装包。**0.1.9 改为机器级安装，需要管理员权限**；从 0.1.8 及更早的用户级安装升级，安装位置会改变，升级后请核对版本号。
3. 在 App 中自行登录，打开课程并进入章节学习页，再使用右侧控制面板。
4. 使用 AI 前，安装并配置自己的 DeepSeek Harness 和模型凭据。程序不附带 API Key，也不提供内置题库。

AI 会读取程序生成的题目图片并给出答案，再由程序校验选项。图片、公式、题型和页面结构都可能影响结果，请先核对答案，再决定是否启用自动提交。识别会使用你配置的模型服务，并可能产生调用费用。

## 使用前请了解

平台页面改版可能影响功能，遇到问题可在 Issues 中反馈。0.1.9 的功能和操作方式见 [更新说明](docs/releases/0.1.9.md)。

安装包暂未数字签名，下载运行时可能出现 SmartScreen 提示。验证码、人脸验证等身份校验需要本人完成。请遵守所在学校和平台的使用规定，不要把工具用于冒用身份、伪造学习记录或其他违规用途。

## 从源码构建

需要 Windows x64、Node.js 和 npm。

```powershell
cd desktop
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1
```

构建说明见 [desktop/BUILD.md](desktop/BUILD.md)。修改用户脚本后，运行 `node userscript/build.mjs`，并将生成文件同步到 `desktop/userscript/` 后再打包。

```text
desktop/          桌面客户端、控制面板和打包脚本
userscript/src/   用户脚本源码
userscript/tests/ 离线测试
docs/             使用说明、更新记录和历史核验记录
```

## 开发与许可

项目由 Invariant-325 维护和发布，使用 DeepSeek 和 Codex 辅助编程、调试与打包。Issue 需包含应用版本、复现步骤、预期行为、实际结果和错误日志。密码、API Key、Cookie 及登录回调参数须脱敏。

项目采用 [GPL-3.0-only](LICENSE)。修改后再分发须遵守 GPL 的源码提供与许可要求。另见 [开源声明](OPEN_SOURCE.md)、[第三方组件说明](NOTICE.md) 和 [免责声明](DISCLAIMER.md)。

学习通、超星、chaoxing、xuexitong 为兼容性检索关键词，不是本工具的品牌名称。
