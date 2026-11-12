const assert=require('node:assert/strict');const {JSDOM}=require('../userscript/node_modules/jsdom');const {readChapterProgress,readPlatformHtml,catalogRequestUrl}=require('../desktop/catalog-progress.cjs');
(async()=>{
 const d=new JSDOM('<div id="done"><span class="icon_Completed prevTips"><span class="prevHoverTips">已完成</span></span></div><div id="pending"><span class="catalog_points_yi prevTips"><span class="prevHoverTips">1个待完成任务点</span><span class="orangeNew">1</span></span></div>').window.document;
 assert.equal(readChapterProgress(d.querySelector('#done')).pending,0);assert.equal(readChapterProgress(d.querySelector('#pending')).pending,1);
 const bytes=Buffer.from([0xd2,0xd1,0xcd,0xea,0xb3,0xc9]);assert.equal(await readPlatformHtml({headers:{get:()=> 'text/html; charset=GBK'},arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}),'已完成');
 global.location={href:'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=fixture'};const original='https://mooc1.chaoxing.com/mycourse/studentstudycourselist?courseId=fixture&original=unchanged';global.window={performance:{getEntriesByType:()=>[{name:original},{name:'https://evil.test/mycourse/studentstudycourselist'}]}};
 assert.equal(catalogRequestUrl(),original);assert.equal(catalogRequestUrl(),original);d.defaultView.close();console.log('PASS actual marker shapes, pending marker never means done, GBK decoding, original directory URL reuse and foreign URL rejection');
})().catch(e=>{console.error(e);process.exitCode=1});
