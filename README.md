# 学习通助手 · Chaoxing Helper

一个学习通辅助项目，包含 Windows Electron 桌面客户端和 Tampermonkey 用户脚本。项目保留了课程自然播放、任务状态跟踪、章节切换及 AI 题目辅助代码。

桌面端把网页与控制面板放在同一窗口里，账号登录由用户自行完成；0.1.2 起的章节测验闸门会尝试自动填写并提交，具体行为见下方说明。默认按 1.0 倍速正常播放，不修改进度或伪造学习时长。

> 许可证：**GPL-3.0-only** · [开源声明](OPEN_SOURCE.md) · [免责声明](DISCLAIMER.md)

## 下载与安装

- **优先使用 [v0.1.1 稳定封装版](https://github.com/Invariant-325/chaoxing-helper/releases/tag/v0.1.1)**：本轮已完成安装与启动验收。
- [查看所有版本](https://github.com/Invariant-325/chaoxing-helper/releases)：包括 v0.1.0 历史归档及 v0.1.2、v0.1.3 后续更新。

Windows x64 用户下载 `Setup-x64.exe` 后按向导安装；免安装版需要完整解压，再运行“启动学习通助手.cmd”或 `app/ChaoxingHelper.exe`。不要只复制 EXE，也不要直接在 ZIP 内运行。

源码主分支保留当前 v0.1.3 工程。v0.1.2 和 v0.1.3 的本地构建产物作为预发布归档，不把 v0.1.1 的验收结论套用到后续版本。

## 功能与验证状态

| 项目 | 当前说明 |
|---|---|
| Windows 安装、启动、重开与卸载 | v0.1.1 已实测通过 |
| 控制面板、学习通公开首页、设置保存、启动日志 | v0.1.1 已实测通过 |
| 视频自然播放、任务点识别与章节切换 | 原工程已实现并有历史测试记录；本次上传未重新做账号内验收 |
| 弹题、章节测验识别与 AI 建议 | 代码保留；依赖模型配置及页面适配，不能视为本次重新验证通过 |
| v0.1.2 / v0.1.3 | 后续工程快照，按预发布管理；0.1.3 新增版本号与手动更新说明 |

登录后进入课程的章节学习页再使用控制面板。AI 识别需要用户自己的 DeepSeek Harness 与 API 配置；仓库不包含账号、Cookie、API Key 或登录数据。0.1.2 起源码默认启用章节测验闸门：可能在视频结束后自动识别、填写并提交测验，还会尝试处理二次确认弹窗。运行前请阅读 [章节测验行为与更新说明](docs/installation-and-updates.md)，需要人工核对时先暂停；本次没有实机验证这些提交路径。

## AI 视觉识别与作答

桌面端的做题链路是：题目区域截图 → DeepSeek Harness headless 会话 → AI 根据图片识别题干和选项并生成答案 → JSON 与选项校验 → 显示或填写结果。0.1.2 起的章节测验闸门还可能继续执行提交步骤。

它不是内置题库，也没有把维护者的 API Key 打进源码。运行时从当前电脑的 `VISION_API_KEY`、`DEEPSEEK_API_KEY` 或用户自己的 DeepSeek Harness 本地凭据读取配置。下载者需要自行配置凭据；仓库不含这些凭据文件。离线测试中的 `sk-fake-for-smoke-test` 是假 Key，不可用于请求服务。

截图会由用户配置的识别链路处理；图像模糊、识别失败或选项不匹配时，代码会返回失败或不确定状态。本轮归档未重新验证真实题目的正确率。

## 项目结构

```text
desktop/                   Electron 主进程、预加载、控制面板与内嵌用户脚本
userscript/src/            模块化用户脚本源码
userscript/dist/           用户脚本构建产物
userscript/tests/          离线测试与页面 fixture
userscript/probe/          页面诊断探针
userscript/proxy/          本地模型代理
userscript/tools/          视觉识别辅助工具
docs/development/          原工程阶段 A/B/C/D 开发记录（已脱敏）
docs/                      安装启动验收与旧版说明
history/                   额外历史快照及来源说明
```

## 手动更新

当前没有自动更新功能。请先退出旧版，再运行新安装包；0.1.3 的“更新说明”按钮只展示更新方式。查看 [核对后的安装与更新说明](docs/installation-and-updates.md) 和 [DeepSeek 原稿](docs/development/安装与版本更新-DeepSeek原稿.md)。

## 从源码构建

### Windows 桌面客户端

安装 Node.js 与 npm，在 `desktop/` 下执行：

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build.ps1
```

首次运行需要下载 Electron、构建依赖与 NSIS。构建脚本会验证中英文资源及打包内容。详见 [桌面端构建说明](desktop/BUILD.md)。

### 用户脚本

```sh
cd userscript
node build.mjs
```

将生成的 `userscript/dist/chaoxing-helper.user.js` 安装到 Tampermonkey。离线测试入口是 `userscript/tests/run-tests.mjs`，测试使用 jsdom；本次公开归档没有纳入本机 node_modules 缓存。

## 版本沿革

| 版本 | 内容 |
|---|---|
| [v0.1.0](https://github.com/Invariant-325/chaoxing-helper/tree/v0.1.0) | 原始桌面发布源码与安装脚本；保留已知问题，供对照 |
| [v0.1.1](https://github.com/Invariant-325/chaoxing-helper/tree/v0.1.1) | 安装封装修复、中英文资源、可写日志、iframe 枚举与退出清理 |
| [v0.1.2](https://github.com/Invariant-325/chaoxing-helper/tree/v0.1.2) | 后续工程，增加章节测验闸门等逻辑 |
| [v0.1.3](https://github.com/Invariant-325/chaoxing-helper/tree/v0.1.3) | 增加界面版本号与手动更新说明，保留对应源码和本地安装包 |

原工程未发现 Git 提交历史。本仓库按照现存发布包和源码补录版本快照，不代表恢复了原始逐次开发提交，也没有回填或伪造历史提交日期。详见 [快照来源](history/README.md) 和 [更新记录](CHANGELOG.md)。

## 启动排查

先将完整文件解压或安装到普通用户可读写目录。v0.1.1 的启动日志位于 `%APPDATA%/chaoxing-helper-desktop/logs/startup.log`；免安装版还提供“诊断启动.cmd”。

本项目不需要永久关闭 Electron sandbox 或系统防护。当前自用构建没有发布者数字签名。

## 项目说明

前期工程由 DeepSeek 辅助开发，安装封装修复与公开归档由 Codex 协助完成。历史报告中的验证记录与本轮可复核验收范围分别保留，避免把源码存在等同于功能已验收。

本项目维护者有权授权的原创代码采用 **GPL-3.0-only**。允许商用、修改和再分发；分发受 GPL 约束的衍生作品时，需要按 GPL 提供对应源码。完整条款见 [LICENSE](LICENSE)，并请阅读 [开源声明](OPEN_SOURCE.md)、[免责声明](DISCLAIMER.md) 和 [第三方说明](NOTICE.md)。第三方组件保留原许可。
