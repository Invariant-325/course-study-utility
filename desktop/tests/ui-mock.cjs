const {contextBridge,ipcRenderer}=require('electron');const record=(type,value)=>ipcRenderer.send('probe',{type,value});
const qr='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZngAAAAASUVORK5CYII=';
contextBridge.exposeInMainWorld('__cxApp',{
 coursesList:async()=>({ok:true,courses:[{id:'a1',name:'Test <img src=x onerror=alert(1)>'},{id:'b2',name:'Second course'}]}),courseStatus:async()=>({phase:'verification',verification:{kind:'face',image:qr,expired:false}}),courseOpen:async id=>{record('open',id);return{ok:true}},courseStart:async()=>{record('start','pending');return{ok:true,pending:true}},courseCancelStart:async()=>({ok:true}),courseOverview:async()=>({ok:false}),
 tasksList:async()=>({ok:true,tasks:[]}),statsGet:async()=>({ok:true,today:{}}),visionStatus:async()=>({hasKey:false}),onLog:()=>{},kvGet:(_k,d)=>d,kvSet:()=>{},evalMain:async()=>({ok:true,result:{mounted:false,snap:{}}}),toggleWeb:async flag=>{record('web',flag);return{ok:true,visible:!!flag}}
});
