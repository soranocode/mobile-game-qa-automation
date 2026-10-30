import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {fileURLToPath} from 'node:url';
import {prepareCannedEatMission} from './factory.mjs';
import {HUD_READY_CODE} from '../inventory-learning/inventory-actions.mjs';

const HUD='CanvasController/PlayerScreen/SafeArea/UIHudInterfaceButtonsPanel/UIHudInterfaceBackpack';
const CLOSE='CanvasInterface/Backpack/SafeArea/RootNavigationWidget/CloseButton';
const USE='CanvasInterface/Backpack/Container/Main/InventoryExtendable/ActionWithItemsButtons/UseButton';
const CONTINUE='CanvasController/DialogWindow/Content/Buttons/DialogChoiceButton(Clone)';
const shared=fileURLToPath(new URL('../inventory-learning/',import.meta.url));
const source=fileURLToPath(new URL('.',import.meta.url));

// This transport interprets only fixture operations. It never loads a Unity connector.
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'canned-eat-offline-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const templates=Object.fromEntries(await Promise.all(['click','probe','snapshot-inventory','use-guard'].map(async name=>[name,await fs.readFile(path.join(shared,name+'.cs.txt'),'utf8')])));
  const uiInput=await fs.readFile(path.join(source,'quest-imgui-canned.cs.txt'),'utf8');
  const uiRead=await fs.readFile(path.join(source,'quest-ui-observe-canned.cs.txt'),'utf8');
  const state={active:false,cycle:Boolean(options.cycle),armed:Boolean(options.cycle),open:false,panel:'None',page:0,inventory:false,selected:false,quantity:8,uses:0,quest:Boolean(options.activeQuest),dialog:Boolean(options.knownDialog),continues:0,instance:41,observed:false,done:false,doneReads:0,held:false,questStatus:'idle',parameterFile:null,target:null,commands:[],waits:[],begins:0,finishes:0,guardInstalls:0,cycleChecks:0,clock:0};
  const watch=()=>({available:true,armed:state.armed,epoch:'fixture-epoch',blocked:false,new_errors:0});
  const questState=()=>({status:'sent',open:state.open,panel:state.panel,page:state.page,target_page:2,target_uid:'canned_eat',visible_labels:state.panel==='Quests'&&state.page===2?['canned_eat']:[],error_watch:watch()});
  const snapshot=()=>({error_watch:watch(),cells:state.inventory?[
    {id:30,storage:'Backpack',index:3,uid:state.quantity?'Canned':null,q:state.quantity,dur:0,selected:state.selected&&state.quantity>0},
    {id:31,storage:'Belt',index:0,uid:'Rifle',q:1,dur:59,selected:false}
  ]:[],controls:state.inventory?[{id:20,path:CLOSE},{id:40,path:USE}]:[{id:10,path:HUD},...(state.dialog?[{id:50,path:CONTINUE}]:[])],texts:state.dialog?[{path:'CanvasController/DialogWindow/Line',text:'Eat canned'}]:[]});
  const session={active:false,cycleActive:state.cycle,executionGuard:options.cycle?()=>{}:null,toolSequence:0,
    instrument(code){assert.ok(code.includes('__ERROR_WATCH_SETUP__'));return code.replace('__ERROR_WATCH_SETUP__','/* fake watcher */');},
    guard(check){assert.equal(this.executionGuard,null);state.guardInstalls++;this.executionGuard=check;return()=>{this.executionGuard=null;};},
    checkCycleSnapshot(w){state.cycleChecks++;assert.equal(w.epoch,'fixture-epoch');assert.equal(w.available,true);assert.equal(w.armed,true);assert.equal(w.blocked,false);},
    async begin(args){assert.deepEqual(args,{expectedErrors:[]});state.begins++;if(options.beginThrows)throw Error('Acknowledgment unknown');if(options.unconfirmed)return{status:'idle'};this.active=true;state.active=true;state.armed=true;return{status:options.pendingBegin?'pending':'stopped'};},
    async finish(){state.finishes++;this.active=false;state.active=false;state.held=Boolean(options.cleanupHeld);state.armed=options.disarmCycle?false:this.cycleActive;if(options.cleanupError)state.cleanupError=true;},
    async invoke(name,args,{checkGuard=true}={}){
      assert.equal(name,'execute_code');if(checkGuard)this.executionGuard?.();this.toolSequence++;const code=args.code;state.commands.push({code,checkGuard});let result;
      if(code.includes('// canned-eat native ownership snapshot'))result={playing:true,paused:false,scene:'Game',active:state.active,cycle:state.cycle,held:state.held,quest_input_status:state.questStatus,error_watch:state.cleanupError?{...watch(),new_errors:1,blocked:true}:watch()};
      else if(code.includes('// canned-eat input parameters'))result={initialized:true,input_sent:false};
      else if(code.includes('SetString("QaAgent.QuestUi.params",')){state.parameterFile=JSON.parse(code.match(/SetString\("QaAgent\.QuestUi\.params",("(?:[^"\\]|\\.)*")\)/)[1]);result={bound:true,input_sent:false};}
      else if(code.includes('var mode="prepare"')){state.observed=true;state.done=false;result={status:'prepared',input_sent:false};}
      else if(code.includes('var mode="stop"')){state.observed=false;result={status:'stopped',input_sent:false};}
      else if(code.includes('var mode="read"')){
        assert.equal(state.observed,true);const ready=state.done&&++state.doneReads>(options.doneDelay??0)&&!options.missingDone;
        result={status:'observed',active:state.quest,active_instance:state.quest?state.instance:0,steps:state.quest?[{uid:'canned_eat',need:1,value:0,complete:false}]:[],error_watch:watch(),done:ready?{observed:true,quest_uid:'canned_eat',quest_instance:options.wrongInstance?state.instance+1:state.instance,completion_fresh:true,final_complete:true,steps:[{uid:'canned_eat',need:1,value:1,complete:true}]}:{observed:false}};
      }
      else if(code===uiInput){
        const [role,target]=String(await fs.readFile(state.parameterFile,'utf8')).split('\n');
        if(role==='open')state.open=true;
        else if(role==='menu'){assert.equal(target,'Quests');state.panel='Quests';}
        else if(role==='page_next')state.page++;
        else if(role==='page_prev')state.page--;
        else if(role==='quest'){assert.equal(target,'canned_eat');state.instance++;state.quest=true;state.done=false;state.doneReads=0;}
        else if(role==='back'){if(state.panel==='Quests')state.panel='None';else state.open=false;}
        else throw Error('Unexpected fixture role '+role);
        state.questStatus='sent';result={status:'click_queued'};
      }
      else if(code===uiRead)result=questState();
      else if(code==='return UnityEditor.SessionState.GetString("QaAgent.QuestUi.status","idle");')result=state.questStatus;
      else if(code.includes('SetInt("QaInventoryLearning.targetId",')){state.target=Number(code.match(/targetId",(\d+)/)[1]);result=true;}
      else if(code===templates.probe)result={status:'ready'};
      else if(code===templates.click){
        if(state.target===10)state.inventory=true;
        else if(state.target===20)state.inventory=false;
        else if(state.target===30)state.selected=true;
        else if(state.target===50){assert.equal(state.dialog,true);state.dialog=false;state.continues++;}
        else if(state.target===40){assert.ok(state.quest);assert.ok(state.selected);state.uses++;state.quantity--;state.quest=false;state.done=true;options.onUse?.();}
        else throw Error('Unexpected fixture target '+state.target);
        result={status:'pending'};
      }
      else if(code===templates['snapshot-inventory'])result=snapshot();
      else if(code===templates['use-guard'])result={status:'ready',useInLongUnlock:false};
      else if(code===HUD_READY_CODE)result={status:state.inventory?'covered':'ready'};
      else if(code.includes('GetString("QaInventoryLearning.status",'))result={status:'sent',held:false,error_watch:watch()};
      else throw Error('Unhandled fixture operation: '+code.slice(0,80));
      return{success:true,data:{result}};
    }
  };
  const handle=await prepareCannedEatMission({session,parameterDirectory:directory,wait:async ms=>{state.waits.push(ms);state.clock+=ms;options.onWait?.(ms);},now:()=>state.clock});
  return{handle,session,state,directory};
}

test('registration performs local I/O only, with no preliminary engine stage',async t=>{
  const {handle,state,directory}=await fixture(t);
  assert.deepEqual(Object.keys(handle).sort(),['cancel','run','sources']);
  assert.equal(state.commands.length,0);assert.equal(state.begins,0);assert.equal(state.finishes,0);
  assert.equal((await handle.cancel()).never_run,true);
  assert.ok((await fs.stat(path.join(directory,'click.cs.txt'))).isFile());
});

test('same handle runs a fresh current quest twice and preserves separate evidence',async t=>{
  const {handle,state,directory}=await fixture(t);
  const first=await handle.run({taskId:'authorized-first'}),second=await handle.run({taskId:'authorized-second'});
  assert.equal(first.result,'PASS_MISSION');assert.equal(second.result,'PASS_MISSION');
  assert.notEqual(first.current_instance,second.current_instance);
  assert.equal(first.food.quantity_before,8);assert.equal(second.food.quantity_after,6);
  assert.equal(state.uses,2);assert.equal(state.finishes,2);assert.equal(state.armed,false);assert.equal(state.active,false);
  assert.equal(first.quest_ui_actions.length,7);assert.equal(second.quest_ui_actions.length,5); // Current page is retained, so the second launch needs no paging.
  assert.equal(state.waits.filter(ms=>ms===1000).length,first.quest_ui_actions.length+second.quest_ui_actions.length);
  assert.equal(state.commands.some(c=>c.code.includes('SetBool("QaInventoryLearning.warmup",true)')),false);
  assert.ok((await fs.stat(path.join(directory,'result-1.json'))).isFile());
  assert.ok((await fs.stat(path.join(directory,'result-2.json'))).isFile());
  assert.ok(state.commands.filter(c=>!c.checkGuard).length>0);
});

test('owned-cycle mission cleanup retains cycle, watcher epoch and enclosing guard',async t=>{
  const {handle,state,session}=await fixture(t,{cycle:true});const inherited=session.executionGuard;
  const result=await handle.run({taskId:'owned-cycle'});
  assert.equal(result.result,'PASS_MISSION');assert.equal(result.input_stopped,true);
  assert.equal(state.cycle,true);assert.equal(state.armed,true);assert.equal(state.active,false);
  assert.equal(state.guardInstalls,0);assert.equal(session.executionGuard,inherited);assert.ok(state.cycleChecks>=3);
  assert.equal(state.commands.some(c=>c.code.includes('disarmed = true')),false);
});

test('active current quest is observed without restarting or opening cheat UI',async t=>{
  const {handle,state}=await fixture(t,{activeQuest:true});
  const result=await handle.run({taskId:'already-active'});
  assert.equal(result.result,'PASS_MISSION');assert.equal(result.current_instance,41);
  assert.equal(state.waits.filter(ms=>ms===1000).length,0);assert.equal(state.uses,1);
});

test('active quest with known initial dialog sends one Continue, then one Use without opening Quests',async t=>{
  const {handle,state}=await fixture(t,{activeQuest:true,knownDialog:true});
  const result=await handle.run({taskId:'active-with-dialog'});
  assert.equal(result.result,'PASS_MISSION');assert.equal(result.current_instance,41);
  assert.equal(state.continues,1);assert.equal(state.dialog,false);assert.equal(state.uses,1);
  assert.equal(result.quest_ui_actions.length,0);assert.equal(state.waits.filter(ms=>ms===1000).length,0);
});

for(const kind of ['beginThrows','unconfirmed'])test(kind+': unknown begin never cleans another session or sends Use',async t=>{
  const {handle,state}=await fixture(t,{[kind]:true});const result=await handle.run({taskId:kind});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(result.input_stopped,false);
  assert.equal(state.finishes,0);assert.equal(state.uses,0);assert.equal(state.observed,false);
});

test('pending begin with confirmed own lease cleans it but cannot PASS',async t=>{
  const {handle,state}=await fixture(t,{pendingBegin:true});const result=await handle.run({taskId:'pending'});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(result.input_stopped,true);assert.equal(state.finishes,1);assert.equal(state.uses,0);
});

test('aborted task sends no context input and never claims a session',async t=>{
  const {handle,state}=await fixture(t);const controller=new AbortController();controller.abort();
  const result=await handle.run({taskId:'aborted',signal:controller.signal});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(state.commands.length,0);assert.equal(state.begins,0);assert.equal(state.finishes,0);assert.equal(state.uses,0);
});

test('cancel during settled cheat action stops before food and cleans only owned session',async t=>{
  let cancel;const {handle,state}=await fixture(t,{onWait:ms=>{if(ms===1000)void cancel();}});cancel=()=>handle.cancel();
  const result=await handle.run({taskId:'cancel-in-flight'});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(result.input_stopped,true);assert.equal(state.uses,0);assert.equal(state.finishes,1);assert.equal(state.observed,false);
});

test('delayed fresh matching Done is read repeatedly without a second Use',async t=>{
  const {handle,state}=await fixture(t,{doneDelay:4});const result=await handle.run({taskId:'delayed'});
  assert.equal(result.result,'PASS_MISSION');assert.equal(state.uses,1);assert.ok(state.doneReads>=5);
});

test('cancel after dispatched Use cleans ownership without replaying the consumable',async t=>{
  let cancel;const {handle,state}=await fixture(t,{onUse:()=>{void cancel();}});cancel=()=>handle.cancel();
  const result=await handle.run({taskId:'cancel-after-use'});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(state.uses,1);assert.equal(state.quantity,7);
  assert.equal(result.input_stopped,true);assert.equal(state.finishes,1);assert.equal(state.observed,false);
});

for(const kind of ['missingDone','wrongInstance'])test(kind+': one Use remains final even without matching Done',async t=>{
  const {handle,state}=await fixture(t,{[kind]:true});const result=await handle.run({taskId:kind});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(state.uses,1);assert.equal(state.quantity,7);assert.equal(result.input_stopped,true);
});

for(const kind of ['cleanupHeld','cleanupError','disarmCycle'])test(kind+': unconfirmed cleanup cannot become PASS',async t=>{
  const {handle,state}=await fixture(t,{[kind]:true,cycle:kind==='disarmCycle'});const result=await handle.run({taskId:kind});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(state.uses,1);
});

test('concurrent invocation is rejected and does not create another run',async t=>{
  const {handle,state}=await fixture(t);const running=handle.run({taskId:'first'});
  assert.throws(()=>handle.run({taskId:'duplicate'}),/already running/);
  assert.equal((await running).result,'PASS_MISSION');assert.equal(state.uses,1);assert.equal(state.begins,1);
});
