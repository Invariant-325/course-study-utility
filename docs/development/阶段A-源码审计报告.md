> 历史开发记录：保留原阶段报告，已移除会话 URL 参数与本机用户名。报告中的验证结论属于当时记录；当前可复核范围见仓库 README 与封装验收文档。

# 学习通（超星）网页端自动化助手 —— 阶段 A：现有开源项目源码审计报告

> 审计时间：2026-11-10
> 审计对象：用户指定的 5 个项目 + 主动检索到的补充候选
> 审计方式：**下载真实源码后逐文件阅读**，不是读 README 判断。

---

## 0. 先说结论（TL;DR）

**没有任何一个项目可以直接拿来做基线。** 5 个指定项目每一个都至少违反了你列出的硬性红线中的一条：

| 项目 | 致命问题 | 判定 |
|---|---|---|
| GF 571524 | 篡改 `document.visibilityState` 欺骗平台（硬编码、无法关闭）+ 按索引盲推章节 | ❌ 淘汰 |
| GF 572981 | 强制 2.0 倍速 + 3 秒轮询架构 + 无完成态去重导致的重播风险 | ❌ 淘汰（但一个判定思路可复用） |
| chaolucky18/xuexitongScript | **无 LICENSE（法律上不可复用）** + 远程加载 jQuery CDN + 拦截失焦事件 | ❌ 淘汰 |
| DaRin1403/xuexitong-autostudy | jsDelivr 自动更新（远程代码）+ 向 4 个第三方题库域名外发 + 不支持多视频章节 | ❌ 淘汰 |
| zhu-hailin/chaoxing-ai-assistant | MIT 合规、安全面干净，但 **1.67 MB / 40+ 模块**，且默认开启"强制连续播放"（反失焦检测） | ⚠️ 不做基线，**作为参考实现** |

**推荐方案：薄重写（约 1200–1800 行模块化单文件），选择性复用 MIT 项目的具体选择器与已验证经验；不复制 chaolucky18 的任何代码（无许可证）。**

详细理由见第 4、5 节。

---

## 1. 审计的可复现性说明

本机 `web_fetch` 工具在当前网络下无法直连（`fetch failed`），因此改用 Node 24 + 本机 HTTP 代理（127.0.0.1:7890）抓取，源码快照保存在：

```
_probe/raw/
```

| 文件 | 来源 | 大小 | 阅读方式 |
|---|---|---|---|
| `gf_571524.js` | update.greasyfork.org（由 API JSON 的 `code_url` 取得真实地址） | 11,753 B / 279 行 | **全文逐行** |
| `gf_572981.js` | 同上 | 19,281 B / 481 行 | **全文逐行** |
| `cl_v3.user.js` | raw.githubusercontent.com，`master` | 27,924 B / 593 行 | **全文逐行** |
| `dr_main.user.js` | 同上，`main` | 86,967 B / 1,739 行 | 关键段落精读（L1255–1364、L1488–1607）+ 全文正则扫描 |
| `zh_bundle.user.js` | 同上（构建产物） | 1,671,122 B | **全文正则扫描** + 关键模块精读 |
| `zh_background-playback.js` | `sources/` 源模块 | 12,345 B / 184 行 | **全文逐行** |
| `zh_course-video-quiz.js` | `sources/` 源模块 | 29,745 B | 结构 + 选择器常量精读 |
| `zh_自动课程架构.md` 等文档 | 仓库 docs | 24 KB 等 | 全文 |

**诚实声明**：Zhu-hailin 的产物是 1.67 MB 单文件，DaRin1403 是 1739 行单文件，二者我**没有**做到逐行通读全文。对这两个项目，我采用了「关键模块逐行精读 + 全文正则扫描（安全面/危险调用/域名/进度篡改）」的组合方式。凡是本报告里标注"未验证"的结论，都请按未验证对待。

---

## 2. 逐项目深评

### 2.1 Greasy Fork 571524 —— 「学习通课程自动播放切换章节/伊皮万版」

- 作者 Puffer BPuffer，v1.0，写于 2026-03-28，总装机 26
- 许可证 **CC-0**，`@grant none`
- 代码 279 行，单文件

**实现**：递归遍历 iframe 找 `<video>`（L103–124）；`ended` + `timeupdate`（进度 ≥99.5%）双判定（L127–163）；按目录节点**索引 +1** 切章（L166–215）。

**否决理由**：

1. **篡改页面可见性（硬伤）** L90–95：

   ```js
   Object.defineProperties(document, {
       hidden: { value: false, configurable: false },
       visibilityState: { value: 'visible', configurable: false },
       ...
   ```

   这不是"优化体验"，是**让平台的风控逻辑认为用户从未离开页面**。你的要求明确写着"不伪造学习时长、不尝试绕过检测"。且 `configurable: false` 写死后无法在页面上恢复，只能刷新。
2. **同为反检测的失焦拦截** L84–88：在捕获阶段 `stopImmediatePropagation()` 掉 `blur / visibilitychange / mouseleave / mouseout`。
3. **按索引 +1 推进**，完全不看平台显示的完成状态 → 已完成章节会重播、非视频节点（填空/测验/文档）会被跳过或卡住。
4. **不支持同章多视频**：`doc.querySelector('video')` 只取第一个，结束后直接"下一节"。
5. **事件监听泄漏**：L221–223 `currentVideo.removeEventListener('ended', () => {})` —— 匿名函数永远无法匹配原处理器，实际什么也没移除。
6. 无暂停/停止、无持久化、无重试、无弹题、无异常恢复。

唯一"干净"的地方是它没有任何网络请求。

**结论：淘汰。零复用价值（连选择器思路都被 572981 覆盖得更好）。**

---

### 2.2 Greasy Fork 572981 —— 「超星学习通自动播放助手」

- 作者 PoplarTang，v2.2，写于 2026-04-08，总装机 89
- 许可证 **MIT**，`@grant none`，481 行单文件

**它有一个真正值得复用的关键发现**（L261–293）：

```js
const icons = Array.from(innerDoc.querySelectorAll('.ans-job-icon'));
const unfinishedIcon = icons.find(icon => icon.getAttribute('aria-label') === '任务点未完成');
```

**用平台自己渲染的"任务点未完成"图标来判断进度**，而不是自己记账。这精确命中你需求里的"优先根据平台正常显示的完成状态判断进度"、"不能仅凭本地记录就认定平台已完成学习"。这是本次审计中最有价值的单条经验。

它还顺带支持：`iframe` 内找 video、文档类任务点滚动（L409–434）、`.btnSave` 暂存按钮（L297–316）、`popDiv + #prevNextFocusNext` 切章（L319–359）、localStorage 恢复运行态（L193–196）、可拖拽面板。

**否决理由**：

1. **强制 2.0 倍速**，L372–395、L395 都是硬编码 `video.playbackRate = 2.0`。与"默认保持 1.0 倍速"直接冲突，且 2 倍速是平台重点识别的特征。
2. **架构是 3 秒 `setInterval` 轮询**（L456–461），不是事件驱动。你的要求是"优先事件驱动，减少高频轮询"。
3. **重播死循环风险（真实存在）**：`checkAndPlay` 在 `currentVideo.ended` 后置空并 `setTimeout(2000)` 重新 `findNextTask()`。若平台尚未把 `aria-label` 从"未完成"改为"已完成"，它会**再次选中同一个视频重新播放**。没有任何"已处理视频"去重集合兜底。
4. **`video.onended = ...`**（L404）直接**覆盖**平台播放器自己的 onended 处理器，可能破坏平台的正常进度上报。
5. **`findNextTask` 用 `document.querySelector('iframe')` 取第一个 iframe**（L253），页面结构一变即失效。
6. **死代码**：`scrollAttempts`（L414）定义了但从未使用，文档滚动失败会无限重试。
7. 切章只依赖页面上的 `prevNextFocusNext` 按钮，按钮不存在就 `isRunning = false` 直接停，不会尝试目录点击。
8. 无弹题处理、无暂停/继续、无错误日志分级、无异常恢复。

**结论：淘汰作为基线，但 `ans-job-icon[aria-label]` 完成态判定必须复用。**

---

### 2.3 chaolucky18/xuexitongScript —— 星数最高（★3966），质量最被高估

- 创建 2020-03-08，最近 push 2026-10-16，67 个 open issue
- **无 LICENSE 文件**（内容目录里确实没有；issue #89 "补个LICENSE" 仍未合并）
- 主脚本 `v3_optimized.user.js` v3.3.0，593 行

**优点（确实有）**：

- **事件驱动**做得好：`ended / loadedmetadata / play / pause` + 1 秒巡检兜底（L489–548）。
- **事件生命周期管理**做对了：用稳定 handler 引用 + `_detachVideoEvents()`（L489–519），修掉了历史 issue #24/#37/#27/#9 抱怨的"每次 play() 都新增监听"。
- **支持同章多视频**：`currentCellIndex`（章）+ `currentNCellIndex`（节）双层索引，`nCells.length > currentNCellIndex + 1` 时同章前进（L112–131）——正好命中你的需求 4。
- 有防重复导航锁 `_nextUnitPending`（L103–106）。
- 有"无进度看门狗"：7 秒 `currentTime` 不变就尝试恢复（L179–197）。
- 有播放失败重试（`maxRetries: 10`）与静音回落（L353–383）。
- 章节测验页最多尝试 3 次防循环（L309–325）。
- `destroy()` 完整清理（L563–579）。
- 仓库里有 `ISSUES_REVIEW.md`，作者对 45 个 issue 做了分类复盘，态度罕见地诚实（明确写了"倍速与任务点被平台服务端强制，不尝试绕过"）。

**否决理由**：

1. **没有许可证** —— 这是**法律层面的硬否决**。无 LICENSE 默认「保留所有权利」，你不能合法复制、修改、分发它的代码。即使只改几行也不行。这一条就足够把 ★3966 排除。
2. **远程加载第三方代码**（L27–38）：

   ```js
   script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
   ```

   正是你红线里的"不使用未经验证的第三方远程执行代码"。而且部分学校的 CSP 会直接拦掉，导致脚本静默失效（对应 issue #62 "关于使用油猴插件后无法正常生效"）。
3. **失焦拦截**（L549–562）：`mouseleave`/`mouseout` 上 `stopPropagation + preventDefault`，`blur`/`visibilitychange` 时立刻 `_tryResumePlayback`。同样是反检测。
4. **默认 1.5 倍速**（L62 `playbackRate: 1.5`）。
5. **完全不判断平台完成状态**：纯索引推进，与需求 6"已经完成的视频不重复播放"冲突。
6. `_getTreeContainer()` 会缓存 `_treeContainerEl`（L445–454），切章后若目录 DOM 重建，缓存的就是失效节点。
7. 切章靠 `setTimeout(3000)` 硬等（L406–411）。
8. 无持久化（刷新即丢进度）、无 UI 面板、无弹题。

**Issue 侧的真实反馈（比 README 更可信）**：67 个 open issue 里，近半是同几类问题反复出现且未解决 ——
#92「网络较慢时打开页面不会自动播放」、#90「没有视频时不自动下一节」、#70「无法被记为完课」、#63「无法自动播下一节」、#61「播放中的课程视频中的随堂测验问题无法自动跳过」、#59「最小化/后台播放有时会暂停」、#55「视频左下角UI显示播放状态，但视频实际上处于暂停」。
一个 ★3966 的项目在最核心的"播完自动切下一节"上还有这么多未闭合问题，说明星数主要来自 2020 年的历史积累，**不代表当前可用性**。

**结论：淘汰。代码一行都不能复制（无许可证）。**

---

### 2.4 DaRin1403/xuexitong-autostudy —— 功能最全，红线最多

- 创建 2026-09-02，最近 push 2026-10-20，8 个 open issue
- **MIT**，单文件 86,967 B / 1,739 行

**它能做到的事**（确实覆盖面最广）：视频/音频/PPT/图片任务点、章节测验自动答题、视频弹题自动作答、字体加密自动解密（Canvas 字形对比）、6 家模型平台、拟人化延迟、每日时长上限、状态上报。

**否决理由（每一条都足以单独否决）**：

1. **远程代码自动更新**（L1695–1702）：空闲时从 `cdn.jsdelivr.net` 拉 `version.json` 并自动刷新升级。你的红线第 5 条明令禁止。
2. **向第三方题库域名外发题目**。`@connect` 白名单（L18–24）里包含：

   ```
   api.tikuhai.com   ← 题库海
   cx.icodef.com     ← OCS 网课助手接口
   tk.enncy.cn       ← 同上
   api.muketool.com  ← 木马题库
   ```

   L567 直接 `POST https://api.muketool.com/cx/v2/query`。也就是说**你的题目会被发到至少 4 个非官方第三方答案库**，这与"不读取、不上传不必要的数据"冲突，且这些域名你不控制。
3. **内置"拟人化防检测"**：`randomSleep(answerIntervalMin, answerIntervalMax)`（L1513）、可配置的"故意答错率"、"每日时长上限"。虽然默认答错率为 0，但这是为规避检测而设计的机制。
4. **不支持同章多视频**（与你需求 4 直接冲突）：`newChapterLoop` 里用 `fs.find(f => /\/ananas\/modules\/video\//.test(f.src))`（L1577）**只取第一个**视频 iframe，播完就 `clickNextSection()`。同章第二个视频被跳过。
5. **默认 2.0 倍速**（L1285 `player.playbackRate(CONFIG.speed)`，默认 `speed: 2`）。
6. **架构是线性脚本流程而非状态机**：`newChapterLoop` 顺序执行 [顶层测验 → 学习检测 → 视频 → 图片 → PDF → 切节]，任何一步 await 卡死就整条流程停摆，没有可恢复的运行状态。
7. **静音强制**（L1284 `player.muted(true)`）。
8. 关键完成判定依赖平台全局函数 `win.isUnFinishJob()`（L1306）—— 这是平台内部函数，随时可能消失。
9. 无任何自动化测试。

**结论：淘汰。它的思路（暂停即弹题 → 三窗口找题）可复用，代码不复用（虽然 MIT 允许，但整体不可拆）。**

---

### 2.5 zhu-hailin/chaoxing-ai-assistant —— 唯一通过安全红线的项目

- 创建 2026-10-08，**最近 push 2026-11-04**（五个项目里最新、迭代最活跃）
- ★124 / fork 8 / **open issue = 0**，6 个 closed issue 处理都比较及时（#5「自动学习停止」有 4 轮讨论）
- **MIT**，有完整 docs、有 `AGENTS.md` 协作规则、有 CHANGELOG（55 KB）

**安全面（本次审计最干净的一个）**：

我用全文正则扫了 1.67 MB 产物：

| 检查项 | 结果 |
|---|---|
| `eval(` / `new Function` | **0 次** |
| `@require` 远程脚本 | **0** |
| jsDelivr / unpkg 等第三方 CDN | **0** |
| `document.write` | 0 |
| 外部域名 | 只有 `api.deepseek.com` / `api.openai.com` / `dashscope.aliyuncs.com` / `api.moonshot.cn` / `open.bigmodel.cn` / `api.github.com` / `raw.githubusercontent.com` + chaoxing/xuexitong 自身（`i.chaoxing.com`、`mooc1*.chaoxing.com`、`mooc2-ans.chaoxing.com`、`resapi.chaoxing.com` 等）。另有三处 URL 仅出现在版权注释/命名空间里（`pajhome.org.uk`、`blueimp.net`、`w3.org`），**不是运行时请求** |
| `@connect` 白名单 | 10 条，**不含任何第三方题库域名**（对比 DaRin1403 的 4 个） |
| 是否改 `currentTime` / seek | **否**（全库仅 1 处读 `visibilityState`，是只读判断） |
| 平台接口调用 | 只有 3 处 GET（读图片 arraybuffer、读课程首页 `i.chaoxing.com/base`），**没有任何写接口** |

它**不伪造学习记录**，只读平台状态 + 调你自己的模型 API。这点很关键。

**架构（也是它最值得学的地方）**：

- `sources/` 下 40+ 个职责单一模块（目录识别、状态机、播放适配、弹题、模型服务商、调度器…），`build_script.py` 合成单文件。
- `sources/course-runner.js`（178 KB）是**真正的状态机 + 运行锁 + 恢复 token**，不是线性脚本。
- `sources/course-video-quiz.js`（29.7 KB）是**独立、可复用的弹题适配器**，选择器常量很完整：

  ```
  容器:  .ans-videoquiz, [data-video-quiz-root]
  提交:  #videoquiz-submit, [data-video-quiz-submit]
  继续:  #videoquiz-continue, .ans-videoquiz-continue
  反馈:  [data-video-quiz-result], .videoquiz-result, ...
  ```

  并且用 `MutationObserver`（L177）而非轮询、有题目 hash 去重（L71）、有 attempts 上限、有 "manual-wait"（等人工）状态、"主循环唯一接管入口，监听器不能启动第二个模型请求"（L155 注释）—— 这几乎就是你要的第三阶段设计的成熟版。
- `sources/background-playback.js`（184 行，我全文读了）是"独立播放与自动刷课之间的播放协调"，写得很克制：有 `COURSE_RUN_LIMITS.maxResumes` 上限、有 `AbortController`、有 `requireUserStart` 人工优先、显式 `release/close` 清理。
- 有 **40+ 个 DOM 测试**（`tests/*.cjs`），包括 `course-runner-dom.cjs`（373 KB）、`video-quiz-dom.cjs`（44 KB）、`2 个 fixtures` 的弹题 HTML。

**它唯一踩的红线**：

`background-playback.js` L106–118 的 `onMouseExit`：

```js
event.stopImmediatePropagation();
event.stopPropagation();
```

用于阻止平台在鼠标移出时暂停视频；配套 `courseForcePlaybackEnabled()`（bundle L8763）：

```js
return get('cx_course_force_playback', true) !== false;   // 默认 true
```

UI 里也是 `<input id="course-force-playback" checked /> 强制连续播放`。

**好消息**：它是**可配置开关，能关掉**（对比 571524 的 `configurable:false` 写死）。**坏消息**：默认开着，而且"刷课期间沿用刷课保护"，默认体验就是反失焦检测。

**越界范围要说准确**（这一点为它辩护）：它只拦截 `window` 上的 `mouseout`，且条件是 `event.relatedTarget !== null` 时直接 return —— 即只在鼠标**真正移出浏览器窗口**时才拦，用途是阻止"鼠标移出播放器 → 平台暂停"。它**没有**拦截 `blur` / `visibilitychange`：这两个事件只注册了前台唤醒回调（`onForeground` 里只有 `active?.wake?.()` 和 `tick()`，不调用 `stopPropagation`），所以切到后台时视频仍会按平台规则暂停。它的越界程度明显轻于 571524 和 chaolucky18（后两者是 4 个事件全拦 + 篡改可见性属性）。

其他默认值（`start()` 参数，bundle L9068/L9109）：
- `muteVideo: true`（默认静音）
- `videoQuizAuto: true`（默认自动处理弹题）
- `speedEnabled: false` → **默认 1.0 倍速**（这点符合你的要求）
- 还有"视频间隔"（固定/随机，默认 10 秒）的拟人化选项

**为什么仍然不做基线**：

1. **体量与需求严重不匹配**。1.67 MB 产物里，我们**不需要**的部分占绝大部分：字体解密（`vendor/font/table.json` 355 KB + Typr.js 43 KB）、UEditor 富文本预填、作业答题、课程队列、待刷滚轮 UI、多平台模型适配、项目介绍弹窗、账号页、图标资源内联…你的验收标准是"可靠、简单、可维护"，fork 它意味着你要在一个 1.6 MB、40+ 模块、Python 构建链的仓库里维护一个只用到 3 个模块的功能。
2. **上游更新必然冲突**。它迭代很快（10 月建仓到 11 月已发到 1.33.4，`docs/` 下 60+ 个版本记录），你 fork 后每次想跟上游同步都要重解冲突。
3. **默认行为需要逐项审计关闭**。"强制连续播放"这类默认值藏在一个 178 KB 的状态机里，逐个确认默认值本身就是高风险工作。
4. 它的核心价值在"答题"（字体解密 + 多平台模型 + 预填），而你只要"视频连播 + 弹题暂停问人"。

**结论：不做基线；作为参考实现，抽取 3 处具体经验（见 §5.2）。**

---

### 2.6 补充检索到的其他项目

`GitHub search: xuexitong in:name,description,readme` 共 402 个结果，按最近更新取前 40 条，**star 最高只有 57**：

| 项目 | ★ | 许可 | 判定 |
|---|---|---|---|
| `yatori-dev/yatori-go-core` | 57 | MIT | **排除**。Go 库，README 明确写"把登录、课程、章节、**学习**、作业和**考试**能力收敛到同一套接口"。这是**协议层刷课**（直接调接口标完成），与"网页端自然播放、不伪造"根本冲突，还包含考试功能。 |
| `yxxawa/xuexitong-ai-helper` | 12 | MIT | 体量太小，非成熟实现，未再深入 |
| `None-wu/courseauto`、`Qiuizi/CourseDesk`、`Thy985/xuexitong`、`upkea/cxmooc-autoplay` 等 | 1–5 | 多为 MIT | 均为 2026-10~11 新建的个人脚本，无社区反馈积累，不能作为可靠性依据 |

**这块生态的现实**：现有项目分两类 —— 一类是 web 油猴脚本（普遍存在反检测思路、体量小、维护弱），一类是协议层工具（`yatori`、OCS 系，直接伪造学习记录，直接违反你的原则）。**不存在"网页端 + 自然播放 + 工程化 + 长期维护"的成熟开源实现。**

---

## 3. 功能与风险比较表

### 3.1 功能维度

| 维度 | 571524 | 572981 | chaolucky18 | DaRin1403 | zhu-hailin |
|---|---|---|---|---|---|
| 最近更新 | 2026-03-28 | 2026-04-08 | 2026-10-16 | 2026-10-20 | **2026-11-04** |
| 代码规模 | 279 行 | 481 行 | 593 行 | 1,739 行 | **1.67 MB / 40+ 模块** |
| 视频识别 | 递归 iframe→`video` | iframe→`video` | `video#video_html5_api` | `videojs()` API | 帧树适配器 |
| iframe 嵌套深度 | 2 层递归 | 1 层 | 2 层递归 | 多层 | 帧树（含跨域检测） |
| 结束检测 | `ended`+`timeupdate≥99.5%` | `ended`+轮询 `ended` 属性 | `ended`+1s 巡检 | `ended`+轮询 `isUnFinishJob()` | 事件+状态机 |
| **同章多视频** | ❌ | ⚠️ 靠 aria-label 逐个（有重播风险） | ✅ 章/节双层索引 | ❌ 只取第一个 iframe | ✅ |
| **按平台完成态判断** | ❌ 纯索引 | ✅ `ans-job-icon[aria-label]` | ❌ 纯索引 | ⚠️ 依赖平台全局函数 | ✅ |
| 章节切换方式 | 目录节点索引+1 | `#prevNextFocusNext` | 目录节点 `posCatalog_name` | 文本匹配"下一节" | 目录 + 队列 |
| 弹题检测 | ❌ | ❌ | ❌ | ✅ 暂停即触发 | ✅ **独立模块+MutationObserver** |
| 异常恢复 | ❌ | ❌（`scrollAttempts` 死代码） | ⚠️ 重试10次+7s看门狗 | ❌ 线性流程 | ✅ 状态机+恢复 token |
| 暂停/停止 | ❌ | ✅（仅开关） | ⚠️ 部分（destroy） | ✅ | ✅ |
| 进度持久化 | ❌ | ✅ localStorage | ❌ | ✅ GM_setValue | ✅ GM 存储 |
| 默认倍速 | 不改动 | **2.0 强制** | **1.5** | **2.0** | **1.0（倍速需手动开）** |
| 事件驱动程度 | 事件+timeupdate | 3s 轮询 | 事件+1s 巡检 | 2s 轮询 | 事件+状态机 |
| 自动化测试 | ❌ | ❌ | ⚠️ 语法校验脚本 | ❌ | ✅ **40+ DOM 测试** |

### 3.2 安全/合规维度（关键）

| 检查项 | 571524 | 572981 | chaolucky18 | DaRin1403 | zhu-hailin |
|---|---|---|---|---|---|
| **许可证** | CC-0 ✅ | MIT ✅ | **无许可证 ❌** | MIT ✅ | MIT ✅ |
| 远程加载第三方代码 | 无 ✅ | 无 ✅ | **`code.jquery.com` ❌** | **jsDelivr 自更新 ❌** | 无 ✅ |
| 向第三方外发数据 | 无 ✅ | 无 ✅ | 无（走本地服务）✅ | **4 个题库域名 ❌** | 无 ✅ |
| 篡改 `document` 属性 | **`visibilityState` 写死 ❌** | 无 ✅ | 无 ✅ | 无 ✅ | 无 ✅ |
| 拦截页面失焦事件 | **是（4 个事件全拦）❌** | 无 ✅ | **是（4 个事件全拦）❌** | 无（但静音+拟人化） | **是：只拦 `window.mouseout`（默认开）⚠️** |
| 拟人化/规避设计 | 有 ❌ | 无 ✅ | 有 ❌ | **有（故意答错率）❌** | 有（视频间隔）⚠️ |
| 修改 `currentTime`/seek | 无 ✅ | 无 ✅ | 无 ✅ | 无 ✅ | 无 ✅ |
| 依赖已失效接口 | 否 | 依赖 `aria-label` 文案 | 依赖 jQuery | 依赖 `isUnFinishJob()` | 依赖原生 DOM 标记 |
| 广告/推广 | 无 ✅ | 无 ✅ | 无 ✅ | 无 ✅ | 无（有赞助入口） |
| 权限声明 | `@grant none` | `@grant none` | `@grant none` | 7 个 GM_* + 9 个 @connect | 11 个 GM_* + 10 个 @connect |

---

## 4. 维护状态与社区反馈对比

| 项目 | 最近更新 | Star | Open Issue | 反馈质量 |
|---|---|---|---|---|
| 571524 | 2026-03-28（7 个月没动） | 26 装机 | — | 无反馈 |
| 572981 | 2026-04-08（7 个月没动） | 89 装机 | — | 无反馈 |
| chaolucky18 | 2026-10-16 | ★3966 | **67** | 同类问题反复未闭合（见 §2.3） |
| DaRin1403 | 2026-10-20 | ★120 | 8 | #3「无法切到下一页/章节」、#2「暂停有问题」、#5「设置按键无法点击」——核心功能不稳 |
| zhu-hailin | **2026-11-04** | ★124 | **0** | #5「自动学习停止」4 轮讨论往返，处理及时 |

**读法建议**：★3966 是 2020 年的历史积累，与当前可用性无关；真正反映维护质量的是「open issue 里同类问题是否被闭合」。按这个标准，chaolucky18 最差，zhu-hailin 最好。

---

## 5. 推荐方案

### 5.1 推荐：薄重写 + 选择性复用（不 fork 任何项目）

**理由链**：

1. 五个指定项目**全部**至少违反一条你的硬性红线，所以"直接用现成的"这条路是关闭的。
2. 唯一通过安全红线的 zhu-hailin，其核心价值（字体解密 + 多平台答题）正是你**不需要**的部分；你需要的部分（视频连播 + 弹题暂停问人 + 异常恢复）只占它的一小部分。fork 它的成本 ≈ 在两个数量级的无关代码里维护你的 3 个模块，且与上游高频更新持续冲突。
3. 三个小脚本的**具体技术判断**已经被验证有效，可以低成本吸收，不需要重复踩坑。
4. 你要的最终形态是「一个能读懂、能改选择器、能自己修 1 年的脚本」。这个目标下，1200–1800 行自己写的代码 ≫ 1.67 MB 继承来的代码。

**为什么这不叫"重复开发"**：真正会被重复开发的只有"DOM 选择器事实"和"事件生命周期模式"，这两样我按 §5.2 直接复用/借鉴，不自己猜。

### 5.2 具体复用清单（合规且明确）

| 复用内容 | 来源 | 许可证 | 合规性 |
|---|---|---|---|
| **完成态判定**：`iframe .ans-job-icon[aria-label="任务点未完成"]`，另可用 `.ans-job-finished` 交叉校验 | 572981 `L261–293` | MIT | ✅ 可复制代码，保留版权声明 |
| **弹题选择器常量**：`.ans-videoquiz` / `#videoquiz-submit` / `#videoquiz-continue` / `[data-video-quiz-result]` / `.videoquiz-result` | zhu-hailin `course-video-quiz.js L2–3` | MIT | ✅ 可复制，保留版权声明 |
| **弹题触发时机**：「播放器进入 paused 且非 ended → 优先判定为弹题 → 再在三层窗口内找题」 | DaRin1403 `L1302–1313`（思路） | MIT | ✅ 思路借鉴 |
| **播放器定位**：iframe 内 `#video_html5_api` / `video.vjs-tech`，优先拿 `videojs` 实例 | DaRin1403 `L1280–1283` + chaolucky18 `L463` | MIT / 无许可 | ⚠️ 仅借鉴"用 videojs 实例 API"这一常识，不复制 chaolucky18 代码 |
| **事件生命周期模式**：稳定 handler 引用 + `detach` 后再绑新 video | chaolucky18 `L489–519`（**只借鉴模式，不复制代码**） | **无许可** | ⚠️ 模式（模式本身不受版权保护），实现自己写 |
| **本地代理安全模型**：`127.0.0.1` + Origin 正则白名单 + 随机 token 注入 + 请求体结构校验 + Key 仅驻内存不落盘 + 429 互斥 | chaolucky18 `deepseek-local.mjs`（**只借鉴设计，不复制代码**） | **无许可** | ⚠️ 这是通用安全模式，独立实现 |
| **状态机 + 恢复 token + `maxResumes` 上限 + `AbortController`** | zhu-hailin `background-playback.js`（思路） | MIT | ✅ 思路借鉴 |

**明确不复用**：571524 的任何部分（篡改可见性 + 索引盲推）；chaolucky18 的任何代码行（无许可证）。

### 5.3 与你的红线对齐的设计约束（供阶段 B 使用）

自建实现将强制满足：

- 默认 `playbackRate = 1.0`，不提供"加速"选项；
- **不拦截** `blur / visibilitychange / mouseleave / mouseout`，**不修改** `document.hidden / visibilityState`，页面切到后台就让它按平台规则暂停；
- 不修改 `currentTime`，不调用 `seek`；
- 不读 Cookie、不碰账号凭证、不发任何 chaoxing 写接口；
- 零 `@require`、零 CDN、零 `eval`；
- 只 `@grant GM_getValue / GM_setValue`（存配置与断点），其余不申请；
- API Key 优先走本地代理（Origin 白名单 + token），脚本内不落明文；
- 有限重试 + 超时 + 结构化日志，绝不无限刷新。

---

## 6. 需要你确认的两个决策点

在进入阶段 B（技术设计）之前，请确认：

**决策 1：接受"薄重写 + 选择性复用"路线吗？**
（备选：坚持 fork zhu-hailin 并裁剪到只剩视频连播 —— 我会照做，但需要明确告知你：这意味着长期维护一个 1.67 MB 基线，且要逐项关闭它的默认反检测行为。）

**决策 2：视频播放期间"切到后台/切标签页"时，你希望脚本怎么做？**
- A. 什么都不做，让平台按它自己的规则暂停（最保守，符合"不绕过检测"）
- B. 检测到"因失去焦点被暂停"时**在 UI 上提示**你，但**不自动恢复**（推荐：信息透明，不越界）
- C. 自动恢复播放（= zhu-hailin 的默认行为，属于规避检测，我不建议）

**决策 3（可选）：你的实际页面结构。** 审计只能基于公开代码 + 仓库里的 fixture 推断选择器。真实的完成态标记、iframe 层级、弹题 DOM 依学校/版本差异很大。若你能提供（脱敏后）一个已完成任务点、一个未完成任务点的 HTML 片段，阶段 C 的选择器命中率会高很多。

---

## 附录：本次审计的源码快照

全部原始文件在 `_probe/raw/`，可直接复核：

```
gf_571524.js  gf_572981.js                      # Greasy Fork 真实源码
cl_v3.user.js  cl_README.md  cl_ISSUES_REVIEW.md  cl_deepseek-local.mjs  cl_console.js
dr_main.user.js  dr_README.md  dr_doc_answer.md
zh_bundle.user.js  zh_background-playback.js  zh_course-video-quiz.js
zh_源码结构.md  zh_自动课程架构.md
*.issues.open.json / *.issues.closed.json        # 各仓库 issue 原始数据
search_xuexitong.json                            # 402 个同类项目的检索快照
yatori_README.md  yatori.meta.json
```
