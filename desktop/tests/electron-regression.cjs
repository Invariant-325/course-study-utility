// Run with the bundled Electron, an isolated --user-data-dir and --no-proxy-server.
// CX_TEST_PHASE=write/read/after-logout; never uses a real account or course.
const { app, BrowserWindow, session, dialog } = require('electron');
dialog.showErrorBox = (title, detail) => console.error(title + '\n' + detail);
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP unit.chaoxing.com 127.0.0.1, MAP quiz.xuexitong.com 127.0.0.1, MAP i.chaoxing.com 127.0.0.1');
const phase = process.env.CX_TEST_PHASE || 'write';
const pause = ms => new Promise(r => setTimeout(r, ms));
const records = [];
const report = text => { records.push(text); console.log('PASS ' + text); };
const root = app.getPath('userData');
fs.mkdirSync(root, { recursive: true });
// A fake CLI checks credential forwarding and consumes the actual generated PNG.
// No network/model requests are made by this fixture.
const mock = path.join(root, 'mock-headless.cjs');
fs.writeFileSync(mock, `const fs=require('node:fs');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{
if(process.env.DEEPSEEK_API_KEY!=='integration-key-placeholder')process.exit(7);
if(fs.existsSync(require('node:path').join(__dirname,'fail-model.flag')))process.exit(9);
const id=s.match(/题目 ID：([^\\n]+)/)[1];const p=s.match(/题目截图（绝对路径）：([^\\n]+)/)[1];
if(!fs.existsSync(p)||fs.readFileSync(p)[0]!==137)process.exit(8);
console.log(JSON.stringify({questionId:id,type:'single',answers:['B'],status:'ok'}));});`, 'utf8');
const cli = path.join(root, 'mock headless.cmd');
fs.writeFileSync(cli, '@echo off\r\n"' + process.env.CX_NODE + '" "' + mock + '"\r\n', 'utf8');
process.env.DSH_CLI = cli;
process.env.VISION_API_KEY = 'integration-key-placeholder';
process.env.DEEPSEEK_API_KEY = 'wrong-inherited-key-placeholder';
let port;
const quiz = `<!doctype html><meta charset="utf-8"><title>Quiz</title>
<div class="TiMu"><div class="Zy_TItle"><i>1</i><span class="newZy_TItle">【单选题】</span><div class="fontLabel">2 + 2 = ?</div></div>
<ul class="Zy_ulTop">${['A','B','C','D'].map((letter,i)=>`<li qid="fixture1" role="radio" aria-checked="false" onclick="for(const e of this.parentElement.children)e.setAttribute('aria-checked','false');this.setAttribute('aria-checked','true')"><span data="${['D','A','C','B'][i]}">${letter}</span><a class="after">${i+3}</a></li>`).join('')}</ul></div><button class="btnSubmit" onclick="window.submitted=true">Submit</button>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/base' && req.headers.host.startsWith('i.chaoxing.com')) return res.end(`<a dataurl="${'http://unit.chaoxing.com:' + port}/courses?origin=platform&amp;proof=signed-demo" onclick="location.href=this.getAttribute('dataurl')">我的课程</a>`);
  if (req.url === '/base?code=callback-demo') return res.end('<a href="/courses">课程</a>');
  if (req.url === '/quiz') return res.end(quiz);
  if (req.url === '/quiz-encrypted') return res.end(quiz.replace('class="fontLabel"', 'class="fontLabel font-cxsecret"'));
  if (req.url === '/wrapper') return res.end(`<iframe src="http://quiz.xuexitong.com:${port}/outer"></iframe>`);
  if (req.url === '/outer') return res.end(`<iframe src="http://quiz.xuexitong.com:${port}/quiz"></iframe>`);
  if (req.url === '/popup') return res.end(`<title>Popup</title><h1>Delayed popup</h1>`);
  res.end(`<title>Fixture</title><h1>${req.url}</h1>`);
});
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { const result = await fn(); if (result) return result; } catch(e) { last=e; }
    await pause(100);
  }
  throw new Error('Timeout: ' + label + (last ? ' ' + last.message : ''));
}
server.listen(0, '127.0.0.1', async () => {
  port = server.address().port;
  require('../main.js');
  try {
    await app.whenReady();
    const ses = session.fromPartition('persist:chaoxing');
    let invalidCourseRequestCount = 0;
    ses.webRequest.onBeforeRequest({ urls: ['https://i.chaoxing.com/base*', 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu*'] }, (details, cb) => {
      if (details.url.includes('/mycourse/stu')) { invalidCourseRequestCount++; cb({cancel:true}); }
      else cb({ redirectURL: `http://i.chaoxing.com:${port}/base` });
    });
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    const panel = win.webContents;
    await until(() => panel.executeJavaScript('!!window.__cxApp && document.readyState === "complete"'), 'panel ready');
    const evalPanel = expression => panel.executeJavaScript(expression, true);
    const goto = url => evalPanel(`window.__cxApp.goto(${JSON.stringify(url)})`);
    const base = `http://unit.chaoxing.com:${port}`;
    const info = () => evalPanel('window.__cxApp.pageInfo()');
    await goto(base + '/courses');
    if (phase !== 'write') {
      const cookies = await ses.cookies.get({ name: 'session_fixture' });
      assert.equal(cookies.length, phase === 'read' ? 1 : 0);
      if (phase === 'read') {
        assert.equal(cookies[0].value, 'session-demo-value');
        assert(cookies[0].httpOnly && cookies[0].session);
        const persistent = await ses.cookies.get({ name: 'persistent_fixture' });
        assert.equal(persistent.length, 1);
        report('session + persistent cookies restored after process restart');
        await ses.cookies.remove(base, 'session_fixture');
        await ses.cookies.remove(base, 'persistent_fixture');
        await ses.cookies.remove(base, '_uid');
      } else report('logout remains logged out after restart');
    } else {
      await ses.cookies.set({ url: base, name: 'session_fixture', value: 'session-demo-value', httpOnly: true, sameSite: 'lax' });
      await ses.cookies.set({ url: base, name: 'persistent_fixture', value: 'persistent-demo-value', expirationDate: Date.now()/1000+3600 });
      await ses.cookies.set({ url: base, name: '_uid', value: '12345', domain: '.chaoxing.com' });
      // A known authenticated portal landing redirects once; verification routes don't.
      await goto(`http://i.chaoxing.com:${port}/base`);
      await until(async () => (await info()).url.includes('/courses?origin=platform&proof=signed-demo'), 'post-login native menu navigation');
      assert.equal(invalidCourseRequestCount, 0);
      report('portal menu preserves platform-generated URL parameters; no parameterless course request');
      await goto(`http://i.chaoxing.com:${port}/base?code=callback-demo`);await pause(600);
      assert((await info()).url.endsWith('/base?code=callback-demo'));
      report('login callback is not interrupted by menu routing');
      await goto(`http://i.chaoxing.com:${port}/base/index`);await pause(600);
      assert((await info()).url.endsWith('/base/index'));
      report('portal without course menu stays put instead of guessing a course URL');
      await goto(base + '/mooc2-ans/mycourse/stu?courseid=1&clazzid=2&enc=fixture');await pause(300);
      assert((await info()).url.endsWith('/mooc2-ans/mycourse/stu?courseid=1&clazzid=2&enc=fixture'));
      report('valid course detail keeps complete query parameters');
      await goto(base + '/face/verify'); await pause(300);
      assert((await info()).url.endsWith('/face/verify'));
      report('verification route not interrupted');
      await goto(base + '/wrapper');
      await until(async () => { const r=await evalPanel(`window.__cxApp.evalQuiz('window.__cxChapterQuiz.parse().count')`); return r.ok && r.result === 1; }, 'nested quiz injected');
      const native = await evalPanel(`window.__cxApp.evalQuiz('({host:!!window.__cxHost,node:typeof require})')`);
      assert.deepEqual(native.result, {host:true,node:'undefined'});
      report('cross-origin nested quiz host works with Node disabled');
      await evalPanel('document.getElementById("qAuto").click();true');
      await until(() => evalPanel('document.getElementById("qMsg").textContent.includes("已填 1 题")'), 'panel vision and fill', 25000);
      const answer = await evalPanel(`window.__cxApp.evalQuiz('({chosen:document.querySelector("li[aria-checked=true] span").textContent,submitted:!!window.submitted})')`);
      assert.deepEqual(answer.result, {chosen:'B',submitted:false});
      report('plain question: panel -> PNG -> CLI -> B -> verified fill, no submit');
      const automatic = await evalPanel(`window.__cxApp.evalQuiz('(async()=>{const api=window.__cxChapterQuiz;const q=api.parse().questions[0];return api.vision.ask(api.image.render(q).dataUrl,q.key,q.options.map(o=>o.letter))})()')`);
      assert(automatic.ok && automatic.result.ok, JSON.stringify(automatic));
      report('automatic quiz vision uses native host, no localhost bridge');
      await goto(base + '/quiz');
      await until(async () => (await evalPanel(`window.__cxApp.evalQuiz('1')`)).ok, 'top-level quiz detection');
      report('top-level quiz with unrelated URL found by DOM');
      await goto(base + '/quiz-encrypted');
      await until(async () => (await evalPanel(`window.__cxApp.evalQuiz('window.__cxChapterQuiz.parse().encryptedCount')`)).result === 1, 'encrypted fixture');
      await evalPanel('document.getElementById("qAuto").click();true');
      await until(() => evalPanel('document.getElementById("qMsg").textContent.includes("已填 1 题") && !document.getElementById("qAuto").disabled'), 'encrypted fixture fill');
      report('encrypted-marked question follows native vision path');
      fs.writeFileSync(path.join(root,'fail-model.flag'),'fixture');
      await evalPanel('document.getElementById("qAuto").click();true');
      await until(() => evalPanel('document.getElementById("qList").textContent.includes("SESSION_EXIT_9") && !document.getElementById("qAuto").disabled'), 'model error surfaced');
      fs.unlinkSync(path.join(root,'fail-model.flag'));
      report('model failure shown to user and button re-enabled');
      await goto(base + '/source');
      await evalPanel(`window.__cxApp.evalMain(${JSON.stringify(`(()=>{const child=window.open('about:blank');setTimeout(()=>child.location.href='${base}/popup',100);return !!child})()`)})`);
      await until(async () => (await info()).url.endsWith('/popup'), 'delayed popup');
      const opener = await evalPanel(`window.__cxApp.evalMain('!!window.opener')`);
      assert(opener.result);
      report('popup keeps its native opener for authentication callbacks');
      await evalPanel('window.__cxApp.back()');
      await until(async () => (await info()).url.endsWith('/source'), 'back to popup opener');
      report('delayed blank popup and back restore source instead of blank screen');
      await goto(base + '/a'); await goto(base + '/b');
      await evalPanel('window.__cxApp.back()');
      await until(async () => (await info()).url.endsWith('/a'), 'ordinary back');
      report('ordinary navigation back');
      await goto('http://127.0.0.1:1/unreachable');
      await until(async () => !!(await info()).error, 'load failure reporting');
      await goto(base + '/courses');
      report('navigation error visible and recovery works');
      evalPanel('window.__cxApp.kvSet("__four_fixes__","saved");true');
    }
    fs.writeFileSync(path.join(root, 'results-' + phase + '.json'), JSON.stringify(records, null, 2));
    win.close();
  } catch (error) {
    console.error(error.stack);
    fs.writeFileSync(path.join(root, 'failure-' + phase + '.txt'), error.stack);
    app.exit(1);
  }
});
app.on('will-quit', () => { server.close(); });
