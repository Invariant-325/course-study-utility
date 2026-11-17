const {test}=require('node:test'),assert=require('node:assert/strict');const {JSDOM}=require('../userscript/node_modules/jsdom');const {enterStudyPage}=require('../desktop/course-portal.cjs');
function run(html){const d=new JSDOM(html,{url:'https://mooc1.chaoxing.com/mycourse/stu',runScripts:'outside-only'});d.window.HTMLElement.prototype.getClientRects=()=>[{}];let clicked='';d.window.document.addEventListener('click',e=>{e.preventDefault();clicked=e.target.id});const result=d.window.eval('('+enterStudyPage.toString()+')()');d.window.close();return {result,clicked}}
test('默认任务页进入章节菜单',()=>assert.deepEqual(run('<a id="tasks" href="#">任务</a><a id="chapters" href="javascript:void(0)"> 章 节 </a>'),{result:true,clicked:'chapters'}));
test('优先直接学习入口',()=>assert.equal(run('<a id="chapters" href="#">章节</a><a id="study" href="/mycourse/studentstudy?x=1">学习</a>').clicked,'study'));
test('不点击站外章节链接',()=>assert.equal(run('<a href="https://example.com">章节</a>').result,false));
test('缺少目录不触发其他菜单',()=>assert.equal(run('<a href="#">考试</a>').result,false));

