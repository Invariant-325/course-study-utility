# 0.2.2 回归检查

使用 Electron 运行测试脚本，并为每个脚本指定独立的 --user-data-dir，避免使用日常登录数据。需要先在 desktop 安装依赖。catalog-test.cjs 检查未挂载学习脚本的课程主页、嵌套目录和 onclick 入口；main-integration-test.cjs 检查实际主进程/预加载和进度持久化、夜间定时及取消；qr-regression-test.cjs 保留二维码回归。

security-network-test.cjs 使用 127.0.0.1:443，本地端口须空闲。运行前在本目录生成一日测试证书：

```powershell
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem -days 1 -subj "/CN=unit.chaoxing.com" -addext "subjectAltName=DNS:unit.chaoxing.com"
```

测试先验证真实 TLS 拒绝不受信任证书，再在另一个内存测试分区中仅信任该测试证书，验证页面导航、弹窗、iframe、302 和直接 loadURL 的拒绝行为。测试不更改系统 DNS、代理或证书信任库；主进程夜间模式在定时后立即取消，不执行真实息屏。

证书、私钥、测试用户目录、日志不得随源码分发。此目录未包含测试私钥或真实账号信息。

0.2.3：playback-test.cjs 检查统一控制器，controls-ui-test.cjs 与 controls-mock.cjs 检查原生鼠标和所有按钮标签同步。userscript/tests/study-policy.test.mjs 检查自动默认策略、进度刷新与提前结束证据，完整脚本回归通过 140 项。main-integration-test.cjs 增加学习偏好、提前结束选项与重载恢复检查。

0.2.4：`node tests/desktop-024.test.cjs` 检查任务安排与单章做题调度；nested-playback-test.cjs 检查嵌套播放器恢复；ui-test.cjs 使用隔离账号和模拟数据检查原生鼠标操作、章节颜色、任务拆分及设置。生成的截图和用户目录不随源码分发。
