> 历史开发记录：保留原阶段报告，已移除会话 URL 参数与本机用户名。报告中的验证结论属于当时记录；当前可复核范围见仓库 README 与封装验收文档。

# 阶段 B：技术设计

> 决策依据：阶段 A 审计结论 + 用户确认（薄重写路线；失焦策略 B「提示但不自动恢复」）

## 1. 复用 / 重写边界

| 项 | 决定 |
|---|---|
| 基线 | **新写**，不 fork 任何项目 |
| 完成态判定 | 复用 572981（MIT）的 `ans-job-icon[aria-label]` 事实，代码自写并扩展多信号回退 |
| 弹题选择器 | 复用 zhu-hailin（MIT）的 `.ans-videoquiz` / `#videoquiz-submit` / `#videoquiz-continue` 常量 |
| 事件生命周期 | 借鉴 chaolucky18 的「稳定 handler 引用 + detach」**模式**，代码自写（其仓库无许可证） |
| 本地代理模型 | 借鉴「127.0.0.1 + Origin 正则白名单 + 随机 token + 结构校验 + Key 仅内存」通用安全模式，代码自写 |
| 明确不用 | 571524 全部；chaolucky18 任何代码行；DaRin1403 的 jsDelivr 自更新与第三方题库外发 |

## 2. 强制约束（写进代码，不可配置）

1. `playbackRate` 固定 `1.0`，无加速选项。
2. 不拦截 `blur` / `visibilitychange` / `mouseleave` / `mouseout`；不读写 `document.hidden` / `visibilityState`。
3. 不修改 `currentTime`，不调用 `seek`。
4. 不读 Cookie / localStorage 中的凭证；不打任何 chaoxing 写接口。
5. 零 `@require`、零 CDN、零 `eval` / `new Function`。
6. 只申请 `GM_getValue` / `GM_setValue` / `GM_registerMenuCommand`。
7. 有限重试 + 超时，任何路径都不允许无限循环刷新。

## 3. 模块划分

| 文件 | 职责 | 依赖 |
|---|---|---|
| `meta.js` | UserScript 头（`@match` / `@grant` / `@noframes`） | — |
| `config.js` | 默认配置 + GM 存储读写 + 断点结构 | `log` |
| `log.js` | 分级日志（环形缓冲 + 面板订阅） | — |
| `selectors.js` | **全部 DOM 选择器集中于此**，每项多候选 + 注释说明来源/验证状态 | — |
| `dom.js` | 跨 iframe 文档收集、可见性、安全查询、点击 | `selectors` |
| `course-tree.js` | 任务点枚举、完成态判定、当前定位、下一目标、切章 | `selectors`,`dom`,`log` |
| `video.js` | 播放器定位、事件绑定/解绑、播放、结束判定、倍速锁定 | `selectors`,`dom`,`log` |
| `state.js` | 状态机（纯逻辑、可单测、无 DOM） | — |
| `runner.js` | 主调度：把状态机与 DOM 操作接起来 | 全部 |
| `quiz.js` | 弹题检测与提取（阶段 D） | `selectors`,`dom` |
| `llm.js` | OpenAI 兼容客户端（阶段 D，走本地代理） | `log` |
| `ui.js` | 悬浮面板（拖动/折叠/日志/诊断） | `log` |
| `main.js` | 入口装配 | 全部 |

`build.mjs` 按序拼接为 `dist/chaoxing-helper.user.js`（零依赖 Node 脚本）。

## 4. 状态机

### 4.1 状态

| 状态 | 含义 | 可停留 |
|---|---|---|
| `idle` | 未启动 | 是 |
| `locating` | 正在页面上定位下一个未完成任务点 | 短暂 |
| `playing` | 视频正常播放中 | 长 |
| `settling` | 视频已结束，等待平台把任务点标记为已完成 | ≤20s |
| `advancing` | 正在点击下一个视频 / 下一章 | 短暂 |
| `quizWait` | 检测到弹题，等用户确认（阶段 D） | 长 |
| `paused` | 用户主动暂停 | 长 |
| `blocked` | 需人工处理（异常/无法判定） | 长 |
| `completed` | 全课程无未完成任务点 | 终态 |
| `stopped` | 用户停止 | 终态 |

### 4.2 转移

```
idle ──start──▶ locating
locating ──找到未完成 video──▶ playing
locating ──无未完成──▶ completed
locating ──有任务点但拿不到 video 且重试用尽──▶ blocked
playing ──ended──▶ settling
playing ──平台暂停 且 检出弹题──▶ quizWait ──用户确认──▶ playing
playing ──意外暂停（非 ended、无弹题）──▶ playing（有限恢复，≤maxResume）
playing ──意外暂停 且 恢复用尽──▶ blocked
settling ──完成态变已完成──▶ advancing
settling ──超时且确认 video 已到末尾──▶ advancing（记 warning，不重播同一视频）
settling ──超时且 video 未到末尾──▶ blocked（不重播，提示人工介入）
advancing ──点击命中──▶ locating
任意 ──pause()──▶ paused ──resume()──▶ locating
任意 ──stop()──▶ stopped
```

**关键取舍**：`settling` 超时后**绝不重播同一个视频**。这是 572981 重播死循环的反面设计。平台没记为完成时，重播 57 分钟再等一次是纯浪费；正确做法是明确报告。

## 5. 关键事件流程

### 5.1 启动 → 播放

```
main: 校验 location 是否为课程学习页
runner.start():
  state → locating
  tree.enumerate()            // 收集文档树内所有 .ans-job 任务点 + 完成态
  当前定位 = 第一个 完成态=未完成 且 类型=video 的任务点
  无 → state=completed
  有 → video.attach(job)
        video.play()           // playbackRate=1.0
        state=playing
```

### 5.2 播放中

```
video 'ended'        → runner.onEnded() : state=settling, 启动 settle 观察器
video 'pause'        → 若 ended 忽略；否则 runner.onUnexpectedPause()
                        - quiz.detect() 命中 → quizWait
                        - 未命中 → 计数 +1，≤3 次则 resume，否则 blocked
video 'error'        → 记录 + blocked（不无限重试）
watchdog(15s, 可关)  → currentTime 停滞 & !paused & readyState<3 → 记日志，不刷新页面
```

### 5.3 视频结束 → 下一视频 / 下一章

```
settle 观察器: MutationObserver 监听任务点容器的 class/aria-label
  变化为「已完成」→ clearTimeout → advance()
  超时 20s → 读 video.currentTime/duration
      ≥ duration-1s → 记 warning「平台未记为完成」→ advance()
      否则 → blocked（提示：可能是网络/心跳未上报）
advance():
  重新 enumerate()
  同页存在下一个未完成 video → 点击它 → locating
  否则 → 点击目录下一个未完成节点 / 页面「下一节」
  点击后等 iframe load 或完成态变化（≤15s）→ locating
```

## 6. 选择器适配策略

所有选择器在 `selectors.js` 中按「语义名 → 候选数组」组织，查找时按序尝试，第一个命中的生效：

```js
jobContainer: ['.ans-job', '[data-isjob="true"]', '.ans-job-finished']
jobIcon:      ['.ans-job-icon']
jobFinishedClass: 'ans-job-finished'
iconLabelUnfinished: ['任务点未完成']
iconLabelFinished:   ['任务点已完成', '已完成']
videoEl:      ['#video_html5_api', 'video.vjs-tech', 'video']
catalogItem:  ['.posCatalog_select', '.posCatalog_level li', '#coursetree li']
nextButton:   ['#prevNextFocusNext', '.nextChapter']
```

每一项旁标注 `// 来源: xxx / 验证状态: 未在真实页面验证`。面板提供 **诊断** 按钮，导出：所有可达文档的选择器命中计数、iframe 层级与 src、任务点列表与完成态、video 元素信息 → 便于按真实页面收敛选择器。

## 7. 异常恢复策略（有限重试表）

| 场景 | 策略 | 上限 |
|---|---|---|
| 视频元素拿不到 | 等 iframe load + 重试定位 | 6 次 × 2.5s |
| `play()` 被拒 | 记日志 → 面板提示「请点一下页面」（不静音、不伪造） | 3 次 |
| 意外暂停（无弹题） | 恢复播放 | 3 次 |
| 视频结束但未记完成 | 等待完成态 | 20s |
| 切章点击无效果 | 换下一候选选择器重试 | 3 次 |
| 页面结构未知 | 停止并提示，给出诊断入口 | 0（不猜） |
| 网络错误 / `video.error` | 记日志 → blocked | 0（不自动整页刷新） |

**永不自动刷新整页**。刷新会丢播放状态且可能被判定异常行为。

## 8. 安全设计（LLM）

- 默认模式：**本地代理** `http://127.0.0.1:8787`，Node 服务负责持有 Key 并转发到 OpenAI 兼容端点；服务端校验 `Origin` 必须匹配 `*.chaoxing.com`，校验随机 token，校验请求体结构，串行互斥，Key 只在内存。
- 脚本侧 `@connect 127.0.0.1`，不 `@connect *`。
- 直连模式为**可选**，需用户在 Tampermonkey 中手动把域名加入 `@connect`（预置 `api.deepseek.com` 等常见域名），面板明文提示风险。
- 阶段 C 不包含任何 LLM 代码（按用户要求先稳定播放）。

## 9. 测试计划（阶段 E）

| 层 | 方式 | 能否本地完成 |
|---|---|---|
| 状态机转移 | 纯 Node 单测（无 DOM，依赖注入） | ✅ |
| 完成态判定 | jsdom + 手写任务点 HTML fixture | ✅ |
| 任务点枚举 / 下一目标选择 | jsdom fixture（多视频章节、已完成章节） | ✅ |
| 事件生命周期 | jsdom + 假 video 元素，验证绑定次数不增长 | ✅ |
| 重播死循环回归 | 模拟「ended 后平台不更新完成态」 | ✅ |
| 真实播放 | **需真实页面**，给出人工测试清单 | ❌ 待用户 |

## 10. 阶段 C 交付范围

正常播放（1.0x）、`ended` 结束检测、自动切下一视频、自动切下一章、暂停/继续/停止、异常提示、悬浮面板、诊断导出、断点保存。

**不包含**：弹题、LLM（阶段 D）。
