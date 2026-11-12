# 0.2.2 回归检查

使用 Electron 运行测试脚本，并为每个脚本指定独立的 --user-data-dir，避免使用日常登录数据。需要先在 desktop 安装依赖。catalog-test.cjs 检查未挂载学习脚本的课程主页、嵌套目录和 onclick 入口；main-integration-test.cjs 检查实际主进程/预加载和进度持久化、夜间定时及取消；qr-regression-test.cjs 保留二维码回归。

security-network-test.cjs 使用 127.0.0.1:443，本地端口须空闲。运行前在本目录生成一日测试证书：

```powershell
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem -days 1 -subj "/CN=unit.chaoxing.com" -addext "subjectAltName=DNS:unit.chaoxing.com"
```

测试先验证真实 TLS 拒绝不受信任证书，再在另一个内存测试分区中仅信任该测试证书，验证页面导航、弹窗、iframe、302 和直接 loadURL 的拒绝行为。测试不更改系统 DNS、代理或证书信任库；主进程夜间模式在定时后立即取消，不执行真实息屏。

证书、私钥、测试用户目录、日志不得随源码分发。此目录未包含测试私钥或真实账号信息。
