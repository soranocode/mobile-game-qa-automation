import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createInventoryMotor} from '../inventory-learning/motor.mjs';
import {createInventoryActions} from '../inventory-learning/inventory-actions.mjs';
import {createCannedQuestBindings} from './bindings.mjs';
import {runCannedEat} from './run.mjs';
import {ERROR_WATCH_SNAPSHOT} from '../../../../tools/unity-ui/error-monitor.mjs';

const SOURCE=fileURLToPath(new URL('.',import.meta.url));
const INVENTORY=fileURLToPath(new URL('../inventory-learning/',import.meta.url));
const HUD='CanvasController/PlayerScreen/SafeArea/UIHudInterfaceButtonsPanel/UIHudInterfaceBackpack';
const CLOSE='CanvasInterface/Backpack/SafeArea/RootNavigationWidget/CloseButton';
const NATIVE=ERROR_WATCH_SNAPSHOT+`// canned-eat native ownership snapshot
return new{playing=UnityEditor.EditorApplication.isPlaying,paused=UnityEditor.EditorApplication.isPaused,scene=UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,active=UnityEditor.SessionState.GetBool("QaAgent.FastUi.active",false),cycle=UnityEditor.SessionState.GetBool("QaAgent.FastUi.cycle_active",false),held=System.AppDomain.CurrentDomain.GetData("QaInventoryLearning.held")!=null,quest_input_status=UnityEditor.SessionState.GetString("QaAgent.QuestUi.status",""),error_watch=errorWatchSnapshot()};`;
const STATUS=ERROR_WATCH_SNAPSHOT+`return new{status=UnityEditor.SessionState.GetString("QaInventoryLearning.status",""),held=System.AppDomain.CurrentDomain.GetData("QaInventoryLearning.held")!=null,error_watch=errorWatchSnapshot()};`;
const INITIALIZE=`// canned-eat input parameters, inside owned run only
UnityEditor.SessionState.SetBool("QaInventoryLearning.warmup",false);
UnityEditor.SessionState.SetFloat("QaInventoryLearning.hold",0f);
UnityEditor.SessionState.SetFloat("QaInventoryLearning.fraction",0.5f);
return new{initialized=true,input_sent=false};`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Registration is local I/O only. All native context initialization happens in run().
export async function prepareCannedEatMission({session,parameterDirectory,wait=sleep,now=()=>performance.now()}) {
  if(!session?.invoke||!session?.begin||!session?.finish||!path.isAbsolute(parameterDirectory))throw Error('Existing executor session and absolute parameter directory required');
  await fs.mkdir(parameterDirectory,{recursive:true});
  const sources={};
  for(const name of ['click.cs.txt','probe.cs.txt','drag.cs.txt','snapshot-inventory.cs.txt','use-guard.cs.txt']){
    const bytes=await fs.readFile(path.join(INVENTORY,name));
    await fs.writeFile(path.join(parameterDirectory,name),bytes);
    sources['inventory-learning/'+name]=hash(bytes);
  }
  for(const name of ['factory.mjs','run.mjs','bindings.mjs','quest-imgui-canned.cs.txt','quest-ui-observe-canned.cs.txt','quest-observer-canned.cs.txt'])sources['canned-eat/'+name]=hash(await fs.readFile(path.join(SOURCE,name)));
  for(const name of ['motor.mjs','inventory-actions.mjs'])sources['inventory-learning/'+name]=hash(await fs.readFile(path.join(INVENTORY,name)));
  const guardCode=await fs.readFile(path.join(parameterDirectory,'use-guard.cs.txt'),'utf8');
  const motor=await createInventoryMotor({session},parameterDirectory,STATUS);
  const quest=await createCannedQuestBindings({session,parameterDirectory,wait,now});
  const inventory=createInventoryActions({motor,guardCode});
  const execute=async(code,cleanup=false)=>{
    const response=await session.invoke('execute_code',{action:'execute',code,safety_checks:true},{checkGuard:!cleanup});
    if(response?.success!==true||!response.data||!('result' in response.data))throw Error('Native context response unconfirmed');
    return response.data.result;
  };
  let running,controller,serial=0;
  return {
    sources,
    run({signal,taskId}={}){
      if(running)throw Error('Canned mission is already running');
      if(!taskId)throw Error('Fresh scoped taskId required');
      controller=new AbortController();
      const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      const number=++serial,before=session.toolSequence??0;
      let ownedCycle=false;
      const begin=async()=>{
        ownedCycle=Boolean(session.cycleActive);
        const state=await execute(NATIVE);
        if(session.active||!state.playing||state.paused||state.scene!=='Game'||state.active||state.held||state.cycle!==ownedCycle||state.quest_input_status==='click_pending')throw Error('Fresh idle owned Game context required');
        if(ownedCycle)session.checkCycleSnapshot(state.error_watch);
        const ack=await session.begin({expectedErrors:[]});
        // FastUiSession.active is set only after its native begin acknowledgment.
        const owned=session.active===true;
        return{status:owned&&['stopped','idle','sent','target_changed'].includes(ack?.status)?'begun':'pending',owned};
      };
      const boundQuest={...quest,async bind(){
        const state=await execute(NATIVE);
        if(!session.active||!state.active||state.held||state.cycle!==ownedCycle||!state.playing||state.paused||state.scene!=='Game')throw Error('Owned Game session changed');
        if(state.error_watch?.available!==true||state.error_watch.armed!==true||state.error_watch.blocked)throw Error('Current error watcher unavailable or blocked');
        if(ownedCycle)session.checkCycleSnapshot(state.error_watch);
        await execute(INITIALIZE);
        const ui=await motor.snapshot();
        // An already active quest may have opened its known Continue dialog.
        // dismissKnownDialog validates and closes it before any inventory input.
        if(!ui?.controls?.some(c=>c.path===HUD)||ui.controls.some(c=>c.path===CLOSE))throw Error('Mission requires Game with Backpack closed');
        return quest.bind();
      }};
      const cleanup=async()=>{
        await session.finish(); // Retains the cycle watcher when this mission is cycle-owned.
        let state=await execute(NATIVE,true);
        for(let n=0;n<20&&state.quest_input_status==='click_pending';n++){await wait(25);state=await execute(NATIVE,true);}
        let watchValid=state.error_watch?.available===true&&state.error_watch.armed===ownedCycle;
        if(ownedCycle){try{session.checkCycleSnapshot(state.error_watch);}catch{watchValid=false;}}
        return{input_stopped:state.active===false&&state.held===false&&state.cycle===ownedCycle&&state.quest_input_status!=='click_pending',blocked:!watchValid||state.error_watch?.blocked!==false,new_errors:state.error_watch?.new_errors??-1,state};
      };
      const installGuard=check=>{
        // The enclosing cycle owns its guard; local bindings still check this run's signal.
        if(session.cycleActive||session.executionGuard)return()=>{};
        return session.guard(check);
      };
      running=(async()=>{
        const report=await runCannedEat({taskId,authorized:true,quest:boundQuest,inventory,begin,cleanup,installGuard,signal:combined,wait,now});
        const result={...report,source_hashes:sources,mcp_calls:(session.toolSequence??0)-before,quest_ui_actions:quest.getActions(),artifacts_directory:parameterDirectory};
        await fs.writeFile(path.join(parameterDirectory,'result-'+number+'.json'),JSON.stringify(result,null,2));
        return result;
      })();
      const current=running;
      return current.finally(()=>{if(running===current){running=undefined;controller=undefined;}});
    },
    async cancel(){controller?.abort();return running?await running:{input_stopped:true,never_run:true};}
  };
}
