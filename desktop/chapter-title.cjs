function cleanChapterTitle(value) {
 let title=String(value||'').replace(/\s+/g,' ').trim();
 const suffixes=[/\s*(?:任务点\s*)?\d+\s*个\s*(?:待完成|未完成|已完成)(?:任务点)?\s*$/, /\s*(?:已完成|待完成|未完成|剩余)\s*(?:任务点)?\s*[:：]?\s*\d+(?:\s*[/／]\s*\d+)?\s*(?:个|个任务点|任务点)?\s*$/, /\s*(?:已完成任务点|待完成任务点|任务点)\s*[:：]?\s*\d+(?:\s*[/／]\s*\d+)?\s*$/];
 for(let i=0;i<4;i++){const old=title;for(const pattern of suffixes)title=title.replace(pattern,'').trim();if(title===old)break;}
 return title;
}
module.exports={cleanChapterTitle};
