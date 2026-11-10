> 历史开发记录：保留原阶段报告，已移除会话 URL 参数与本机用户名。报告中的验证结论属于当时记录；当前可复核范围见仓库 README 与封装验收文档。

# 阶段 B（修订版）：技术设计与风险说明

> 本文件替代初版《阶段B-技术设计.md》中与下列 6 点冲突的部分。
> 不重做阶段 A；所有引用均来自已落地的源码快照（`_probe/raw/`）。

---

## 0. 修订摘要

| # | 你的质疑 | 判定 | 修订动作 |
|---|---|---|---|
| 1 | `@noframes` 却要访问嵌套 iframe，能否处理跨子域 | **部分成立**：同源 iframe 可直读（与是否注入脚本无关），但我**不该假设所有 iframe 可读**，且代码把跨域 frame 静默跳过了 | 引入 frame 可达性分级 + `inaccessible` 显式上报 + 深度 3→8/12 + 根节点多候选 |
| 2 | 把所有 pause 都当"意外暂停"并自动恢复 3 次，违反 B 策略 | **成立**：这是实现 bug | 新增 `PauseClassifier`，五类暂停分诊，background/user 一律不恢复 |
| 3 | settling 超时看播放头到末尾就切下一节，不符合"可靠完成" | **成立**：把"视频播完"当成了"平台确认完成" | 新增 `awaitingConfirm` 可恢复异常态；`videoEnded` 与 `platformConfirmed` 严格分离 |
| 4 | 不能因当前 DOM 找不到未完成视频就判定整门课完成 | **成立**：会漏掉懒加载章节、折叠组、未知任务点、非视频任务 | 新增 `CourseCompletion` 三态判定（complete / incomplete / unverifiable）+ 证据链 |
| 5 | 不要预设 1200–1800 行；先做诊断工具验证；重新评估 fork | **成立**：我把行数当成了目标 | 先交付只读探针；给出 fork vs 重写的**数据判据**（§6） |
| 6 | `@connect` / fetch / GM_xmlhttpRequest 用法互相矛盾 | **成立**：设计里有含糊表述 | 统一为"只用 GM_xmlhttpRequest + 精确 @connect"，明确禁用页面 fetch 调外部 API（§7） |

---

## 1. iframe 与同源策略

### 1.1 先澄清一个概念（这是你质疑的核心）

`@noframes` 与"访问嵌套 iframe 内的 video"**并不天然矛盾**。同源策略按 **origin** 判定，不按"脚本是否注入"判定：

- 顶层脚本访问 `mooc1.chaoxing.com` 下 iframe 的 `contentDocument` —— **允许**（同源），无论子 frame 里有没有跑脚本。
- 顶层脚本访问 `pan-yz.chaoxing.com`（PPT 阅读器）、`resapi.chaoxing.com` 下的 iframe —— **抛 SecurityError**，无论怎么试。

所以初版真正的错误不是 `@noframes`，而是**把"所有 iframe 都可读"当成了前提**，并且用 `try/catch → continue` 把不可读的 frame **静默吞掉**了。结果是"找不到任务点"却看不出原因。

### 1.2 证据：跨域 frame 确实存在

MIT 项目的 `courseFrameTree()`（`zh_bundle.user.js:7441-7457`）维护了一个 `inaccessible` 数组：

```js
try {
  const doc = frame.contentDocument;
  if (!doc?.documentElement) { if(!courseRemoteReaderFrame(frame)) inaccessible.push(frame); return; }
  ...
} catch { if(!courseRemoteReaderFrame(frame)) inaccessible.push(frame); }
```

并且它在多处**遇到 inaccessible 就拒绝继续**，而不是硬闯：

- `:8088` `if(!fingerprint.doc||tree.inaccessible.length||...) return false;`
- `:10706` `throw ... '任务框架无法读取，请人工检查'`, code `COURSE_FRAME_UNAVAILABLE`
- `:9251` 在特定例外（章节提交帧）之外，`tree.inaccessible.some(...)` 会阻止继续

它同时定义了**已知可跳过的跨域 frame**：`courseAnswerEditorFrame`（答案编辑器）、`courseOptionalBookReaderFrame`（可选图书阅读）、`courseRemoteReaderFrame`（PPT 阅读器，走桥）。

### 1.3 修订后的 frame 可达性模型

把每个 frame 归入四类，**不再静默跳过**：

| 类别 | 判定 | 处理 |
|---|---|---|
| `readable` | `contentDocument` 可访问且有 `documentElement` | 正常参与任务点/video 枚举 |
| `known-skippable` | 跨域，但命中已知无害白名单：UEditor 答案编辑器、可选图书阅读、PPT 阅读器（`iframe#panView` 且在 `[id="img"].imglook` 内） | 记录并跳过，**不计入阻塞** |
| `unreadable` | 跨域且不在白名单 | 计入 `inaccessible[]`，**降级为需人工确认**，不假装成功 |
| `not-yet` | `contentDocument` 存在但 `readyState !== 'complete'` | 短期等待（有上限），不算错误 |

关键约束：
- **不尝试任何跨域绕过**（不读 `window.frames` 猜、不改 document.domain、不注入子脚本去偷 DOM）。
- `inaccessible` 非空时，完成态判定一律降级（见 §4），并在面板显示"存在 N 个无法读取的子框架"。
- 诊断导出必须列出每个不可读 frame 的 `src`、深度、`reason`。

### 1.4 结构性修正

| 项 | 初版 | 修订 | 依据 |
|---|---|---|---|
| 遍历深度 | 3 | **默认 8，可配到 12** | `courseFrameTree` 用 12；真实卡片可能嵌套 4–5 层 |
| 根节点 | `#iframe` | **`#mainid #iframe` 优先，退化 `#iframe`** | `courseFrameTree:7443` 用 `owner.querySelector('#mainid #iframe')` |
| 枚举预算 | 无 | 最多 40 个 document、单 document 最多扫描 3000 节点，超限即停止枚举并记 `budget-hit` | 防止深度放大后遍历爆炸 |

### 1.5 如果真需要读跨域内容（阶段 D/E 视情况）

只有在**验证阶段确认**视频播放器位于跨域 frame 时，才引入跨 frame 通信。届时采用已审计过的成熟模式（`zh_course-document-bridge.js`，MIT，153 行），其安全要点：

1. **双通道**：`postMessage` 为主 + `GM_addValueChangeListener` 随机信箱为备（解决扩展沙箱下 `event.source === null` 的情况，`:135`）。
2. **origin 白名单**：显式域名集合 + 判断函数（`:4-7`），**不用 `'*'`**。
3. **path 白名单**：只认 `/mooc-ans/screen/file`、`/screen/v2/file_`（`:17,86`）。
4. **祖先校验**：只接受自己的祖先窗口，排除同源兄弟 iframe（`:71-82`）。
5. **帧身份校验**：`iframe#panView` 且位于 `[id="img"].imglook` 内（`:14`）。
6. **请求去重**：id → response 缓存（`:91-97`），避免重放。
7. **超时 + 重发 + abort**：30s 超时，250ms 重发（`:53,68`）。
8. **返回值类型校验**：对每个字段做 `Number.isFinite` / 整数 / 关系约束（`:43-44`）。

**但本轮不引入**：引入它需要额外 `@grant GM_addValueChangeListener / GM_deleteValue`，与 §7 的"最小权限"冲突；且我们尚未验证视频 frame 是否跨域。**先探针，后决定。**

---

## 2. 暂停分诊（修掉"统一当意外暂停"的 bug）

### 2.1 问题确认

初版 `onPause()` 的逻辑是：非 `ended` 的 pause → 计数 +1 → 自动 `play()`，3 次后 block。这确实把你选的 B 策略（后台暂停只提示不恢复）**覆盖掉了**：切后台 → 平台暂停 → 脚本自己把播放抢回来。

### 2.2 只读信号源（全部为读取，不篡改）

| 信号 | 用途 | 是否只读 |
|---|---|---|
| `document.visibilityState` | 判断标签页是否隐藏 | ✅ 只读 |
| `document.hasFocus()` | 判断窗口是否聚焦 | ✅ 只读 |
| `visibilitychange` / `focus` / `blur` 事件 | 记录状态变化的**时间点**（只监听，不 stopPropagation） | ✅ 只监听 |
| `video.readyState` / `video.networkState` | 区分缓冲/加载 | ✅ 只读 |
| `stalled` / `waiting` / `suspend` 事件 | 加载类暂停的证据 | ✅ 只监听 |
| `pointerdown` / `keydown`（捕获，仅记录时间） | 判断是否人工操作 | ✅ 只监听 |
| 弹题容器是否存在（`.ans-videoquiz` 等） | 判断弹题暂停 | ✅ 只读 |

> 红线保持：**不拦截**这些事件、**不写** `document.hidden` / `visibilityState`。只是读。

### 2.3 分诊矩阵（按优先级，命中即返回）

| 优先级 | 条件 | 分类 | 动作 | 是否计数 |
|---|---|---|---|---|
| 1 | `video.ended` | `ended` | 走结束流程 | — |
| 2 | 存在弹题容器 | `quiz` | 进入弹题流程（阶段 D；当前=提示人工） | — |
| 3 | 3 秒内有 `pointerdown`/`keydown` | `user` | **提示"你手动暂停了"，不恢复** | 否 |
| 4 | `visibilityState === 'hidden'` | `background` | **提示"标签页切到后台，平台已暂停。回到前台后点继续"，不恢复** | 否 |
| 5 | `!hasFocus()` 且 60 秒内发生过 `blur` | `background` | 同上 | 否 |
| 6 | `readyState < 3` 或 `networkState === NETWORK_LOADING` 或 3 秒内有 `stalled/waiting` | `loading` | 等待（有上限），**不恢复、不计数** | 否 |
| 7 | 其他 | `unexpected` | 有限恢复播放 | 是，上限 3 |

### 2.4 与 B 策略的一致性

- `background` / `user` → 状态进入 `paused`，面板写明原因，**脚本不碰播放器**。你回来后点「继续」。
- 这只在 **`unexpected`** 分支才会 `play()`，且 3 次封顶。
- 新增一条回归测试：模拟 `visibilityState=hidden` 时触发 pause，断言 `play()` **一次都没被调用**。

**残留风险**：`visibilityState` 为 `'visible'` 但窗口被其他窗口遮挡时无法判定为后台，会落到 `unexpected`。这是浏览器可观测性的上限，接受并在日志中注明。

---

## 3. 结束与确认分离：`settling` → `awaitingConfirm`

### 3.1 问题确认

初版：settling 超时 + 播放头到末尾 → `advance()`。这等于**用视频进度冒充平台确认**，正是你说的"不符合可靠完成"。

### 3.2 修订后的语义

| 概念 | 定义 | 来源 |
|---|---|---|
| `videoEnded` | 播放器报告播到末尾（`ended` 或 `currentTime >= duration - 0.5`） | 播放器事件 |
| `platformConfirmed` | 平台把该任务点渲染为已完成（`.ans-job-icon[aria-label]` / `.ans-job-finished`） | 平台 DOM |

**两者独立。只有 `platformConfirmed` 才能推进。**

### 3.3 状态机新增 `awaitingConfirm`

```
playing --videoEnded--> settling
settling --platformConfirmed--> advancing        （成功路径）
settling --超时仍未确认--> awaitingConfirm        （可恢复异常，不是成功）
awaitingConfirm --观察窗口内确认--> advancing
awaitingConfirm --用户点「继续等待」--> settling（重置计时，次数封顶 3）
awaitingConfirm --用户点「稍后处理/跳过」--> advancing（标记 watchNext=true，后续复核）
awaitingConfirm --用户点「停止」--> stopped
```

`awaitingConfirm` 的界面与行为：

- 面板显示：**「视频已播完，但平台尚未记录完成」** + 已等待时长 + 该任务点标题。
- 三个按钮：`继续等待`（重置观察窗口，最多 3 轮）、`跳过并记录`、`停止`。
- **绝不自动重播**（不会 seek 回 0，不会重新 play）。
- 跳过时不把它当作成功：进度里单列 `pendingConfirm` 计数，日志记 `warn`。

### 3.4 为什么这样更可靠

- 不再有"播完即成功"的假阳性。
- 平台心跳延迟（常见几十秒）可以通过"继续等待"消化，而不是靠重播 57 分钟。
- 若平台确实没记上，你会**立刻看到**，而不是在课程末尾才发现少了一个任务点。

---

## 4. 课程完成判定（三态，不再"看不见就算完成"）

### 4.1 问题确认

初版 `advance()` 里：找不到下一个节点 + 所有可见任务点 finished → `completed`。这漏掉了：懒加载章节、未展开的折叠组、`unknown` 状态任务点、非视频任务点、不可读 frame 里的任务点。

### 4.2 修订：`CourseCompletion.verdict()`

返回三态之一，**只有 `complete` 才允许进入 `completed` 状态**。

| verdict | 成立条件（全部满足） | 界面 |
|---|---|---|
| `complete` | ① 目录已完整枚举：无未展开折叠组（一组里 `isGroup` 且有子项）；② 每个目录项的完成态都读取成功（无 `state === 'unknown'`）；③ 所有任务点 `finished`；④ `inaccessible.length === 0`；⑤ 无 `pendingConfirm` 挂账 | 「本课程已完成」（并列出统计） |
| `incomplete` | 存在明确的未完成项 | 继续推进，不提示完成 |
| `unverifiable` | 上述任一条件**无法确认** | 「无法确认全部完成」+ 逐条原因 + 「打开诊断」 |

`unverifiable` 的 `reasons` 必须具体，例如：

- `catalog-group-collapsed: 第 3 章包含折叠子项，尚未展开`
- `task-unknown-state: 第 2 章第 4 个任务点无法判定完成状态`
- `frame-unreadable: 1 个子框架跨域不可读（src=...）`
- `non-video-task-skipped: 第 5 章有 2 个文档任务点未处理`
- `pending-confirm: 第 7 章第 2 个视频已播完但平台未记录`

### 4.3 关于"要不要自动展开折叠组"

**不自动展开。** 理由：
- 展开折叠组会触发平台的目录懒加载请求，属于额外的页面交互，可能被判异常。
- 是否展开对"我是否该继续播放"没有决定性影响；但**对"是否完成任务"有决定性影响**。
- 所以：不主动展开，但**在 verdict 里明确报告"有未展开章节，因此无法确认完成"**，由你决定是否手动展开。

这直接回应你的要求："不能仅根据当前可访问 DOM 中找不到未完成的视频，就断定整门课程完成。"

---

## 5. 目录与任务点的枚举预算

既然要处理懒加载与折叠，必须防止枚举失控：

| 维度 | 预算 | 超限行为 |
|---|---|---|
| document 数量 | 40 | 停止枚举，记 `budget-hit`，verdict 降级为 `unverifiable` |
| 单文档扫描节点 | 3000 | 同上 |
| 目录条目 | 500 | 同上 |
| 单次运行 advance 次数 | 200 | `blocked` |

---

## 6. 成本控制与 fork / 重写的决策判据

### 6.1 承认错误

我把"1200–1800 行"写成了工程目标，这是本末倒置。**行数不是目标，能读懂、能改选择器、能自己修一年才是。**

### 6.2 先交付只读探针（本轮附带）

`probe/chaoxing-probe.user.js`：**只读，不点击、不播放、不修改任何 DOM**。
- 不带 `@noframes`，在每个 frame 独立采集自己的 `document`，通过 `postMessage` 向顶层汇总（不需要额外 GM 权限）。
- 输出：每层 frame 的 origin / URL / 可达性 / 任务点数 / 完成态文案 / video 数量 / 目录结构摘要 / 已知选择器命中情况。
- 目的：一次性验证 §1 的 frame 模型、§4 的目录结构、以及所有选择器假设。

**在拿到探针输出之前，不再扩展阶段 C 的功能代码。**

### 6.3 fork vs 重写：用数据决定

| 判据 | 指向 fork zhu-hailin | 指向自写（薄实现） |
|---|---|---|
| 探针显示 iframe 跨域严重、深度 > 5、需桥接 | ✔ 它已实现 `courseFrameTree` + 桥 | ✘ 我要重造 |
| 探针显示结构规整（同源、3 层内、选择器稳定） | ✘ 用不到它的 40 个模块 | ✔ 1500 行足够 |
| 你是否需要"章节测验自动答题/字体解密" | ✔ 它内置 | ✘ 不在需求内 |
| 你能否接受"改 3 个默认值 + 精简 UI"作为维护方式 | ✔ 一处 checkbox 改动 | — |
| 你是否需要长期跟随上游修修补补 | ✔ 跟 upstream | ✘ 自己修 |
| 你能否 review 1.67 MB 代码 | ✘ 基本不可能 | ✔ |

**我目前的倾向（待探针数据确认）**：如果探针显示**同源且结构规整**，自写薄实现仍更划算；如果显示**跨域/深度嵌套严重**，则改用 fork + 只改默认值（`cx_course_force_playback=false`、`cx_course_mute_video=false`、`cx_course_video_quiz_auto=false`、`cx_course_speed_enabled=false`），这 4 个键就是全部改动，比自写桥接便宜得多。

### 6.4 现有代码如何处置

不删。`chaoxing-helper/` 保留作为**参考实现与测试资产**（45 个测试仍然有效，尤其是状态机与完成态判定）。若最终决定 fork，这些测试可以移植过去验证行为一致性。

---

## 7. 权限与网络请求的统一约定

### 7.1 现状矛盾

初版同时提到「`@connect 127.0.0.1`」「直连模式需用户手动加域名」「`fetch`」，没有说清三者关系。

### 7.2 统一规则（写死）

| 规则 | 内容 |
|---|---|
| R1 | **所有外部 HTTP 只用 `GM_xmlhttpRequest`**。禁止用页面 `fetch` / `XMLHttpRequest` 调外部 API。 |
| R2 | `@connect` 只精确声明必需域名，**禁止 `@connect *`**。 |
| R3 | 默认走本地代理：`@connect 127.0.0.1`，端点 `http://127.0.0.1:8787/answer`。 |
| R4 | 直连模式为**可选且默认关闭**；开启时 UI 明确提示"需要在脚本头部手动添加 `@connect <你的域名>`，否则请求会被拦截"。 |
| R5 | 不使用 `GM_getTab` / `GM_saveTab` / `GM_addValueChangeListener`，除非 §1.5 的跨 frame 桥被真正启用。 |
| R6 | 不读取 Cookie、不附带 `credentials`、不向 chaoxing 发任何写请求。 |

### 7.3 为什么是 `GM_xmlhttpRequest` 而不是 `fetch`

| 维度 | 页面 `fetch` | `GM_xmlhttpRequest` |
|---|---|---|
| CORS | 受同源策略限制，需服务端 CORS 头 | **不受限**（扩展层发请求） |
| Private Network Access | 从 https 页面访问 `127.0.0.1` 会触发 PNA 预检，易失败 | 不受 PNA 约束 |
| 超时/取消 | 需 `AbortController` 自己管 | 原生 `timeout` + `abort()` |
| 权限可见性 | 无声明，隐式 | `@connect` 显式、用户可见可审 |
| 混合内容 | https 页面调 http 会被浏览器拦 | 不受限 |

结论：`fetch` 在油猴里调本地代理**基本不可行**（这正是初版含糊之处的危险所在）。

### 7.4 阶段 D 的完整权限清单（届时才加）

```
@grant GM_xmlhttpRequest
@grant GM_getValue
@grant GM_setValue
@grant GM_registerMenuCommand
@connect 127.0.0.1
```

`@connect` 默认只有 `127.0.0.1`。直连模式下由用户自行追加，脚本不做动态放行。

---

## 8. 修订后的状态机（v2）

```
idle ──start──▶ locating
locating ──找到未完成 video──▶ playing
locating ──incomplete 且无下一个──▶ completed
locating ──verdict=unverifiable──▶ needsReview
locating ──frame 不可读且必要──▶ blocked

playing ──ended──▶ settling
playing ──pause(quiz)──▶ quizWait        （阶段 D）
playing ──pause(background/user)──▶ paused
playing ──pause(loading)──▶ playing      （等待，不计数）
playing ──pause(unexpected)──▶ playing   （恢复，≤3 次）/ blocked（超限）

settling ──platformConfirmed──▶ advancing
settling ──超时──▶ awaitingConfirm
awaitingConfirm ──确认/跳过/停止──▶ advancing | stopped

advancing ──点击命中──▶ locating
任意 ──pause()──▶ paused ──resume()──▶ locating
任意 ──stop()──▶ stopped

needsReview ──用户处理/继续──▶ locating
```

新增状态：`awaitingConfirm`、`needsReview`。
`completed` 的唯一入口是 `verdict === 'complete'`。

---

## 9. 风险登记表

| ID | 风险 | 影响 | 现有缓解 | 剩余风险 |
|---|---|---|---|---|
| R-1 | 视频播放器位于跨域 frame，顶层读不到 | 核心功能不可用 | §1.3 显式上报 | 需探针确认；若是，须引入桥（+4 类 GM 权限） |
| R-2 | `visibilityState` 只反映标签页，不反映窗口遮挡 | 误判为 `unexpected` 并恢复一次 | 恢复上限 3 次 + 日志 | 接受（浏览器可观测性上限） |
| R-3 | 平台完成态文案因校而异 | unknown 泛滥 → `unverifiable` | 多候选文案 + 诊断导出 | 需按你的学校补 token |
| R-4 | 折叠/懒加载章节无法枚举 | 误判完成 | 三态 verdict + 明确报告 | 不会误判，但可能长期停在 `unverifiable` |
| R-5 | 目录结构出现第三代 | 切章失败 → blocked | 选择器集中 + 多候选 | 需按诊断补 |
| R-6 | 平台心跳延迟 > 观察窗口 | 挂 `awaitingConfirm` | 可「继续等待」3 轮 | 需人工介入 |
| R-7 | 自动恢复被平台判为异常 | 账号风险 | 默认不恢复后台/人工暂停；unexpected 仅 3 次 | 不可完全消除 |
| R-8 | fork 路线下误改上游默认值 | 意外仍开反检测 | 只改 4 个明确键 | 需人工核对 |
| R-9 | 探针在跨域 frame 无法读 DOM | 探针数据不全 | 探针在每个 frame 运行并自报 | 只影响诊断精度 |

---

## 10. 本轮之后的顺序

1. **现在**：本轮只交付「修订设计 + 风险表 + 只读探针」，不动阶段 C 的功能代码。
2. **下一步（需要你）**：在学习通课程页装探针，把导出的 JSON 给我。
3. **然后**：据数据决定 fork 还是继续薄实现，再进入阶段 C 的增量修改（不是重写）。
4. **阶段 D**：在 §7.4 的权限清单下实现弹题 + 代理。
