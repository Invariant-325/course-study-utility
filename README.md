# 课程伴学工具 · Course Study Utility

兼容 **学习通（超星平台）** 的第三方课程辅助工具，包含 Windows Electron 桌面客户端和 Tampermonkey 用户脚本。项目保留了课程自然播放、任务状态跟踪、章节切换及 AI 题目辅助代码。

> 本项目是个人独立开发的第三方兼容工具，并非学习通或超星官方产品，与超星平台不存在隶属、授权、合作或背书关系。相关名称仅用于说明兼容性，其商标及其他权利归各自权利人所有。

桌面端把网页与控制面板放在同一窗口里，账号登录由用户自行完成；0.1.2 起的章节测验闸门会尝试自动填写并提交，具体行为见下方说明。默认按 1.0 倍速正常播放，不修改进度或伪造学习时长。

> 许可证：**GPL-3.0-only** · [开源声明](OPEN_SOURCE.md) · [免责声明](DISCLAIMER.md)

## 下载与安装

- **本地验证版 v0.1.7，尚未上传 GitHub。** 本轮修复登录状态保存、App 内 AI 通道、登录后课程导航及回退空白页。GitHub 公开版本仍为 v0.1.4；请勿把未发布版本的核验结论套用到公开旧包。
- [查看所有版本](https://github.com/Invariant-325/course-study-utility/releases)：包括 v0.1.0 历史归档及 v0.1.2、v0.1.3 后续更新。

Windows x64 用户下载 `Setup-x64.exe` 后按向导安装；免安装版需要完整解压，再运行“启动学习通助手.cmd”或 `app/ChaoxingHelper.exe`。不要只复制 EXE，也不要直接在 ZIP 内运行。

这份本地源码为 v0.1.7；远端主分支仍是 v0.1.4，本轮没有上传。0.1.4 更名为“课程伴学工具”，历史版本保留原名称用于追溯。v0.1.2 和 v0.1.3 的本地构建产物作为预发布归档，不把 v0.1.1 的验收结论套用到后续版本。

## 功能与验证状态

v0.1.7 修正 0.1.6 登录后“无效的参数”：从官方个人首页点击平台自带课程菜单，不再把无参数的具体课程地址当作列表。本机已实测保留原登录并正常显示课程列表。详见 [核验记录](docs/verification-0.1.7.md)。

v0.1.6 的本地集成测试覆盖 Cookie 跨进程恢复及退出登录、跨域嵌套 iframe 测验识别填写、AI 失败提示、弹窗 opener、延迟空白窗跳转和后退恢复；真实模型对自制题目图片返回正确结果。真实账号刷脸及课程端到端效果仍待用户验收。详见 [四项修复核验记录](docs/verification-0.1.6.md)。

v0.1.5 修正内部应用名包含中文导致 User-Agent 无法通过 `btoa` 编码的问题；窗口、安装器和快捷方式仍使用“课程伴学工具”。用户报告 0.1.4 手机刷脸成功后桌面反复要求验证，0.1.1 正常；本轮已确认浏览器标识的编码回归，但尚未证明平台认证代码使用该编码路径，不能宣称真实刷脸流程已修复。见 [核验记录](docs/verification-0.1.5.md)。

v0.1.4 离线测试 **132/132 通过**，修复了测验失败后无法进入人工确认的状态转换问题。已验证 0.1.3 → 0.1.4 覆盖升级、旧测试设置保留、中性标题与兼容声明。真实登录、课程播放、AI 视觉识题及自动提交仍待用户验证。见 [核验记录](docs/verification-0.1.3-0.1.4.md)。

| 项目 | 当前说明 |
|---|---|
| Windows 安装、启动、重开与卸载 | v0.1.1、v0.1.3、v0.1.4 已实测通过 |
| 控制面板、学习通公开首页、设置保存、启动日志 | v0.1.1、v0.1.3、v0.1.4 已实测通过 |
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

## 兼容性与搜索关键词

学习通、超星、chaoxing、xuexitong 仅用于说明兼容平台与帮助检索，不是本工具的名称，也不表示官方隶属或背书。

## 版本沿革

| 版本 | 内容 |
|---|---|
| [v0.1.0](https://github.com/Invariant-325/course-study-utility/tree/v0.1.0) | 原始桌面发布源码与安装脚本；保留已知问题，供对照 |
| [v0.1.1](https://github.com/Invariant-325/course-study-utility/tree/v0.1.1) | 安装封装修复、中英文资源、可写日志、iframe 枚举与退出清理 |
| [v0.1.2](https://github.com/Invariant-325/course-study-utility/tree/v0.1.2) | 后续工程，增加章节测验闸门等逻辑 |
| [v0.1.3](https://github.com/Invariant-325/course-study-utility/tree/v0.1.3) | 增加界面版本号与手动更新说明，保留对应源码和本地安装包 |

v0.1.4：更名、加入醒目的第三方兼容声明、安装包附带 GPL 与免责声明；保留旧安装身份和数据路径以便覆盖升级。

原工程未发现 Git 提交历史。本仓库按照现存发布包和源码补录版本快照，不代表恢复了原始逐次开发提交，也没有回填或伪造历史提交日期。详见 [快照来源](history/README.md) 和 [更新记录](CHANGELOG.md)。

## 启动排查

先将完整文件解压或安装到普通用户可读写目录。v0.1.1 的启动日志位于 `%APPDATA%/chaoxing-helper-desktop/logs/startup.log`；免安装版还提供“诊断启动.cmd”。

本项目不需要永久关闭 Electron sandbox 或系统防护。当前自用构建没有发布者数字签名。

## 项目说明

前期工程由 DeepSeek 辅助开发，安装封装修复与公开归档由 Codex 协助完成。历史报告中的验证记录与本轮可复核验收范围分别保留，避免把源码存在等同于功能已验收。

本项目维护者有权授权的原创代码采用 **GPL-3.0-only**。允许商用、修改和再分发；分发受 GPL 约束的衍生作品时，需要按 GPL 提供对应源码。完整条款见 [LICENSE](LICENSE)，并请阅读 [开源声明](OPEN_SOURCE.md)、[免责声明](DISCLAIMER.md) 和 [第三方说明](NOTICE.md)。第三方组件保留原许可。
