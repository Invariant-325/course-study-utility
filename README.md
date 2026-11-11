# 课程伴学工具 · 0.2.0-beta.2

兼容学习通（超星平台）的 Windows 课程辅助工具。本快照属于 **0.2.0 Beta 预发布系列**，当前正式版本仍为 [0.1.9](https://github.com/Invariant-325/course-study-utility/releases/tag/v0.1.9)。

[下载本版](https://github.com/Invariant-325/course-study-utility/releases/tag/v0.2.0-beta.2) · [更新说明](docs/releases/0.2.0-beta.2.md) · [全部版本](https://github.com/Invariant-325/course-study-utility/releases)

## 本版更新

- 新增课程总览：章节数、待完成数、最近学习和章节列表。
- 新增待办看板：从当前课程导入章节，设置优先级、任务状态和备注，并保存在本机。
- 自动做题和自动提交开关统一移到章节测验卡片。
- 开启夜间模式时自动打开两个开关，不再单独配置夜间勾选项。

待办看板用于记录和整理任务，修改任务状态不会直接驱动课程执行器。

## 使用

当前包含课程总览、待办看板、视频与章节测验控制、内置模型设置。安装完成后，在 App 中登录平台并进入章节学习页。AI 功能通过内置接口调用模型服务，在模型设置中配置自己的 API Key。

自动做题和自动提交开关位于章节测验卡片；开启夜间模式会同时启用两个开关。新配置下默认关闭，已有设置保留。任务看板用于记录任务，不直接调度课程执行器。

安装需要管理员权限。修改源码与构建方式见 [desktop/BUILD.md](desktop/BUILD.md)。账号验证由本人完成，模型结果由使用者核对。

## 开发与许可

项目由 Invariant-325 维护和发布，使用 DeepSeek 和 Codex 辅助编程、调试与打包。Issue 需包含应用版本、复现步骤、预期行为、实际结果和错误日志。密码、API Key、Cookie 及登录回调参数须脱敏。

本项目是个人第三方兼容工具，并非学习通或超星官方产品，与超星平台无隶属、授权、合作或背书关系。采用 [GPL-3.0-only](LICENSE)，另见 [开源声明](OPEN_SOURCE.md)、[第三方组件说明](NOTICE.md) 和 [免责声明](DISCLAIMER.md)。
