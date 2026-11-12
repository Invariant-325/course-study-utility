# README 展示素材

- `logo.png`：直接复制应用现有的 `desktop/ui/assets/logo@2x.png`，未重新设计。
- `home.png`、`workspace.png`：Electron 33.4.11 运行 v0.2.7 的原始 `desktop/ui/index.html` 后，通过 `webContents.capturePage()` 获取的界面截图。
- 截图使用隔离测试配置和测试 IPC 数据，网络请求全部阻断；未使用真实账号、模型密钥或登录 Cookie。封面中的 `SAMPLE COURSE`、课程名称、章节和进度均为示例，不是实际学习记录。
- 测试封面为专用于截图的简单 SVG 素材，不是平台课程封面。没有改动应用的 HTML、CSS 或界面脚本，也未拼接界面、添加外壳或绘制产品 Mockup。
- 图片保留原始宽高比，以 PNG 无损存储。README 中的图片由 GitHub 按可用宽度等比显示。

截图仅用于展示界面，不作为联网兼容性、课程完成率或 AI 正确率的测试证明。
