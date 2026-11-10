// ==UserScript==
// @name         课程伴学工具（自然播放版）
// @namespace    local.chaoxing.natural-watch
// @version      0.1.4
// @description  按平台正常规则连播课程视频（默认 1.0 倍速），播完自动切下一个视频与章节；不改进度、不改倍速、不绕过检测。
// @author       local
// @license      MIT
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc-ans/knowledge/cards*
// @match        *://*.chaoxing.com/mooc-ans/work/doHomeWorkNew*
// @match        *://*.xuexitong.com/mycourse/studentstudy*
// @match        *://*.xuexitong.com/mooc-ans/knowledge/cards*
// @match        *://*.xuexitong.com/mooc-ans/work/doHomeWorkNew*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

// 注入范围说明（2026-11-10 实机验证后收窄）：
//   ✅ /mycourse/studentstudy      唯一确认可工作的学习页（三层同源）
//   ⚠️ /mooc-ans/knowledge/cards   学习页内层 iframe；@noframes 下不会作为顶层注入，
//                                  保留仅为容错（若将来放开子框架注入）
//   ❌ /mooc2-ans/mycourse/*       课程主页壳子：document.domain 不对称导致
//                                  #frame_content-zj 跨域不可读，目录与任务点都在里面，
//                                  在该页启动必然失败，故不再注入。
