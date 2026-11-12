function createSleepGuard(blocker) {
  const reasons=new Set();let id=null;
  function sync(){
    if(reasons.size&&id===null)id=blocker.start('prevent-app-suspension');
    if(!reasons.size&&id!==null){blocker.stop(id);id=null;}
  }
  return {set(reason,on){on?reasons.add(reason):reasons.delete(reason);sync();},close(){reasons.clear();sync();},active:()=>id!==null};
}
module.exports={createSleepGuard};
