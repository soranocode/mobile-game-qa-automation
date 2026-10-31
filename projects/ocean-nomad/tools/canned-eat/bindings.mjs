import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const SOURCE=fileURLToPath(new URL('.',import.meta.url));

// Local source registration only. Engine state is accessed by the returned run-time methods.
export async function createCannedQuestBindings({session,parameterDirectory,sourceDirectory=SOURCE,wait=sleep,now=()=>performance.now()}) {
  if(!session?.invoke||!path.isAbsolute(parameterDirectory))throw Error('Existing executor session and absolute parameter directory required');
  await fs.mkdir(parameterDirectory,{recursive:true});
  const [input,read,observer]=await Promise.all(['quest-imgui-canned.cs.txt','quest-ui-observe-canned.cs.txt','quest-observer-canned.cs.txt'].map(name=>fs.readFile(path.join(sourceDirectory,name),'utf8')));
  const parameterFile=path.join(parameterDirectory,'quest.params');
  const actions=[];let check=()=>{};
  const execute=async code=>{
    check();
    const response=await session.invoke('execute_code',{action:'execute',code,safety_checks:true});
    check();const result=response.data?.result;
    if(result?.error_watch?.blocked||result?.status==='blocked_new_error')throw Error('New Unity error; quest input stopped');
    return result;
  };
  const pause=async ms=>{check();await wait(ms);check();};
  const observerCode=mode=>session.instrument(observer.replaceAll('__MODE__',mode));
  const questState=()=>execute(read);
  return {
    async bind(){
      check();actions.length=0;await fs.writeFile(parameterFile,'observe\n','utf8');
      return execute('UnityEditor.SessionState.SetString("QaAgent.QuestUi.params",'+JSON.stringify(parameterFile.replaceAll('\\','/'))+');UnityEditor.SessionState.SetString("QaAgent.PreparedQuest.uid","canned_eat");return new{bound=true,input_sent=false};');
    },
    beginWatch:()=>execute(observerCode('prepare')),
    watch:()=>execute(observerCode('read')),
    questState,
    async clickQuestUi(role,target=''){
      if(!['open','back','menu','page_next','page_prev','quest'].includes(role)||
        (role==='menu'&&target!=='Quests')||(role==='quest'&&target!=='canned_eat')||
        (!['menu','quest'].includes(role)&&target!==''))throw Error('Unsupported canned_eat UI action');
      check();await fs.writeFile(parameterFile,role+'\n'+target,'utf8');
      const started=now(),ack=await execute(input);
      if(ack?.status!=='click_queued')throw Error('Quest input not queued: '+ack?.status);
      const deadline=now()+2600;let status='click_pending';
      while(status==='click_pending'&&now()<deadline){
        await pause(25);status=await execute('return UnityEditor.SessionState.GetString("QaAgent.QuestUi.status","idle");');
      }
      if(status!=='sent')throw Error('Unknown quest input outcome: '+status);
      await pause(1000); // Learned mandatory cheat-UI settling interval.
      const state=await questState();
      actions.push({role,target,ack,status,state,ms:now()-started});
      check();await fs.writeFile(path.join(parameterDirectory,'quest-ui-actions.json'),JSON.stringify(actions,null,2));
      return state;
    },
    async cleanup(){
      // Dispose only this passive quest subscription; retain the owner's cycle watcher.
      return(await session.invoke('execute_code',{action:'execute',code:observerCode('stop'),safety_checks:true},{checkGuard:false})).data?.result;
    },
    setCheck(fn){if(typeof fn!=='function')throw Error('Check function required');check=fn;},
    getActions:()=>[...actions]
  };
}
