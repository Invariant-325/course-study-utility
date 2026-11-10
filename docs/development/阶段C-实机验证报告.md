> 历史开发记录：保留原阶段报告，已移除会话 URL 参数与本机用户名。报告中的验证结论属于当时记录；当前可复核范围见仓库 README 与封装验收文档。

# 实际页面验证报告（真实环境实测）

> 验证时间：2026-11-10 20:5x（Asia/Shanghai）
> 环境：Microsoft Edge（PID 30916），已登录用户账号
> 课程：形势与政策（2026 年秋），courseid=267253952，clazzid=155119646
> 方法：Edge DevTools Console 注入只读探测代码 → `copy()` 写入剪贴板 → 读取 JSON
> 性质：**只读取证**。未点击播放、未修改任何 DOM、未提交任何任务。

---

## 1. 结论速览

| 假设 | 实测结果 | 判定 |
|---|---|---|
| 学习页是三层 iframe 结构 | top → `#iframe` → video iframe，**正好 3 层** | ✅ 成立 |
| 三层同源可读 | 全部 `mooc1.chaoxing.com`，逐层访问成功 | ✅ 成立 |
| 完成态用 `aria-label` | `aria-label="任务点未完成"` | ✅ 成立 |
| 任务点容器是 `.ans-job` | **不存在**；实际是 `.ans-attach-ct` | ❌ 需修正 |
| 视频元素是 `#video_html5_api` | `id="video_html5_api" class="vjs-tech"` | ✅ 成立 |
| 目录是 `.posCatalog_*` | 40 个 `.posCatalog_select`、9 个 `.posCatalog_level` | ✅ 成立 |
| `#prevNextFocusNext` / `.nextChapter` 存在 | 分别 1 个 / 2 个 | ✅ 成立 |
| 所有页面都同源 | **课程主页 `mooc2-ans` 跨域** | ⚠️ 需规避 |

**总体：原架构在学习页上可行，但选择器必须修正一处（`.ans-job` → `.ans-attach-ct`），并且要避开课程主页的跨域壳子。**

---

## 2. 页面拓扑（实测）

### 2.1 课程主页（跨域，脚本不应在此启用）

```
URL: https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=...&enc=REDACTED
├─ document.domain = "chaoxing.com"   ← 平台把顶层改成了父域
└─ <iframe id="frame_content-zj"
     src="https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?...">
     → contentDocument === null
     → 访问 location.href 抛 SecurityError:
       "Blocked a frame with origin https://mooc2-ans.chaoxing.com from accessing a cross-origin frame"
```

**原因**：顶层 `document.domain` 被设为 `chaoxing.com`，而子 frame 未做同样设置 → 两边 origin 不一致 → 跨域。这是经典的 `document.domain` 不对称陷阱。

**顶层可访问的内容**极少：只有导航菜单（课程门户/任务/章节/讨论/作业/考试/资料…）、用户名、"已完成任务点 0/59" 的**容器**。
**课程目录（40 节）和任务点全在那个跨域 iframe 里。**

→ 结论：**不要试图在 `mooc2-ans` 主页操作**。现有 `isCourseUrl()` 只匹配 `/mycourse/studentstudy` 与 `/knowledge/cards`，正好避开，无需改动。

### 2.2 学习页（同源，真正的工作面）

```
URL: https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1248884878&courseId=267253952&...
│
├─ [depth 0] 目录/壳子
│    #coursetree            ×1
│    .posCatalog_level      ×9      （9 个章）
│    .posCatalog_select     ×40     （40 个节）
│    .posCatalog_active     ×1      （当前节 1.1）
│    #mainid #iframe        ×1
│    #iframe                ×1
│    #prevNextFocusNext     ×1
│    .nextChapter           ×2
│
├─ [depth 1] 卡片页（任务点）
│    URL: https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?...&mooc2=1
│    .ans-job-icon          ×1
│    .ans-job               ×0      ← 不存在！
│    iframe.ans-attach-online.ans-insertvideo-online
│       src=/ananas/modules/video/index.html?v=2026-1106-1930
│
├─ [depth 2] 播放器
│    URL: https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=2026-1106-1930
│    video#video_html5_api.vjs-tech   ×1
│    duration=0  paused=true  readyState=0   （未播放，符合只读原则）
│
└─ [depth 1] 另外 6 个 about:blank iframe（空占位，忽略）
```

---

## 3. 关键选择器实测

### 3.1 任务点容器（必须修正）

`.ans-job` **不存在**。`.ans-job-icon` 的父级链实测为：

```
div.ans-job-icon.ans-job-video.ans-job-icon-clear
  < div.ans-attach-ct.videoContainer
    < p.editor-iframe
      < div.ans-cc
```

→ 容器应取 `.ans-attach-ct`（`.videoContainer` 是它的附加类）。
→ `aria-label="任务点未完成"` 保持不变，判定逻辑可直接复用。
→ iframe 是 `.ans-attach-online.ans-insertvideo-online`，与旧版一致。

### 3.2 目录条目

```
<div class="chapter_unit">                        ← 章
  <div class="chapter_item">                      ← 节
    <div class="catalog_title chapter_Thats_bnt">
      <div class="catalog_num"><span><i><em>1</em></i></span></div>
      <div class="catalog_name newCatalog_name" tabindex="0">
        <a class="clicktitle"><span title="...">...</span></a>
      </div>
      <span class="catalog_upDown ...">
```

`.posCatalog_select` 与 `.chapter_item` **同时存在**（两套结构并存），实测：
- `posCatalog_select firstLayer` → 章（第 1 层）
- `posCatalog_select posCatalog_active` → 当前节
- 文本形如 `1.1 大党之治：百年党史中最恢宏的篇章 2个待完成任务点2`

### 3.3 完成态（两种信号，都要用）

| 层级 | 信号 | 实测值 |
|---|---|---|
| 目录层 | `chapter_item` / `posCatalog_select` 文本 | `2个待完成任务点` / `11个待完成任务点` |
| 任务点层 | `.ans-job-icon[aria-label]` | `任务点未完成` |
| 头部汇总 | `.chapter_head` | `已完成任务点: 0/59` |

**重要**：目录层每个节都有"N个待完成任务点"计数，这是**前置过滤**的最佳信号（不用进节就能判断哪节未完成）。

### 3.4 播放器

```
video#video_html5_api.vjs-tech   （video.js 封装）
duration=0 / paused=true / readyState=0  （未加载）
```

video.js 存在，`playbackRate` 可控。

---

## 4. 业务结构实测

### 4.1 每节的任务点组成

目录徽章显示每节「2」，页面标签显示：

```
[1 课程视频]  [2 章节测验]
```

→ **「2 个待完成任务点」= 1 个视频 + 1 个章节测验**，不是两个视频。

这意味着：
- 「同章多视频」在本课程中**不存在**，但其他课程可能存在，代码仍需支持
- 章节测验**不在本工具范围内**（你不要求答题），必须能识别并跳过/停下，而不是硬当成视频

### 4.2 完成条件

页面原文：

> 完成条件：观看时长需 ≥ 总时长的 90%（未完成任务点前，当前视频不可拖…）

→ 这直接支撑了「不 seek、不伪造进度」的决策：只要自然播放到 90% 以上，平台即认可。

### 4.3 已观察到的平台检测

Console 中出现：

```
[CxRobotSdkJs] 尊敬的开发者您好，您当前正在使用公共授权认证，
可能存在流控风险和功能限制；建议您及时申请专用授权
https://robot-docs.chaoxing.com/docs/ds/auth
```

→ 平台确实有 `CxRobotSdkJs` 机器人检测。这是**不绕过检测**这条红线的现实依据。

---

## 5. 对现有代码的影响（需要改什么）

| 项 | 现状 | 修正 |
|---|---|---|
| `SEL.jobContainer` | `['.ans-job', '[data-isjob]', '.ans-job-finished']` | 加 `'.ans-attach-ct'` 并**前置**（实测唯一有效） |
| `collectJobContainers` | 只查 `.ans-job` | 增加 `.ans-attach-ct` 与 icon 父级 fallback（已有 fallback，需确认父级选择正确） |
| `SEL.catalogRoot` | `['#coursetree', '.posCatalog_level']` | 实测两者都在，保持 |
| `SEL.catalogItem` | `['.posCatalog_select', 'li']` | 实测 `.posCatalog_select` 存在，保持；`li` 需移除（会误匹配） |
| 目录完成态 | 未实现 | **新增**：解析 `N个待完成任务点` 文本作为前置过滤 |
| `isCourseUrl()` | `/mycourse/studentstudy` 等 | 实测正确，保留（天然避开 mooc2-ans 跨域页） |
| `maxFrameDepth` | 3 | 实测正好 3 层，保持 3 即可（不必放大） |
| 章节测验识别 | 无 | **新增**：识别 `2 章节测验` 标签，遇到时停止并提示，不当视频处理 |

---

## 6. 尚未验证的部分

| 项 | 原因 |
|---|---|
| 视频自然播完后 `aria-label` 是否变「任务点已完成」 | 需要真的播完一个视频（约数十分钟），本次未做 |
| `ans-job-finished` 类是否使用 | 当前无已完成任务点可观测 |
| 卡片切换（一节多视频时如何翻页） | 本课程每节只有 1 个视频，无样本 |
| 播完后的完成弹窗 / 「下一节」按钮行为 | 同上 |
| 跨域主页是否有其他入口 | 未深入，因为已确认不在其工作 |

**建议**：下次用最短的一个视频做一次完整播完，观察 `aria-label` 与完成弹窗。这是唯一还缺的关键实证。

---

## 7. 对设计文档的修订结论

1. **第 1 点（iframe 与同源）**：你的担心是对的——但方向要修正。
   - `mooc2-ans` 课程主页：**确实跨域，且是 `document.domain` 不对称导致**。
   - `mooc1` 学习页：**三层全部同源可读**。
   - 因此：不需要跨 frame 通信（不必引入 GM 存储信箱）；只需**把脚本限定在学习页启用**，这已经做到了。
   - 但必须在诊断里明确输出「当前页是否同源可读」，避免再次静默失败。

2. **第 4 点（课程完成判断）**：实测给出了更好的方案——
   - 目录层有 `N个待完成任务点` 计数，可做**前置完成度判断**（无需进节）。
   - 因此「是否全部完成」可以更可靠：所有 `.posCatalog_select` 的待完成计数都为 0。
   - 这比「翻遍所有任务点」便宜得多。

3. **剩余设计（暂停分诊、awaitingConfirm、权限统一）不受本次实测影响**，仍然有效。
