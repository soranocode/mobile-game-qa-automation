// Build local command bindings; Unity compiles each command on its first actual use.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as defense from '../../projects/ocean-nomad/tools/shark-defense/install.mjs';
const exec=code=>({tool:'execute_code',params:{action:'execute',code,safety_checks:true}});
const local=name=>readFile(fileURLToPath(new URL(name,import.meta.url)),'utf8');
const spatial=name=>local('../../projects/ocean-nomad/tools/fast-spatial/'+name);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const observerMode=(source,mode)=>{
  if(!['prepare','read','stop'].includes(mode))throw Error('Unsupported quest observer mode');
  return source.replaceAll('__MODE__',mode);
};
export async function launchKnownQuest({watch,questState,q},mission){
  const started=s=>s.active||(s.done?.observed===true&&s.done.quest_uid===mission&&s.done.completion_fresh===true);
  const transition=async(role,target,expected)=>{
    let last=await questState();if(expected(last))return last;
    for(let attempt=0;attempt<3;attempt++){
      const r=await q(role,target);last=r.state;
      if(expected(last))return last;
      if(!['sent','click_cancelled','not_sent_covered','not_sent_blocked'].includes(r.input.status))throw Error('quest_ui_'+r.input.status);
    }throw Error('quest_ui_transition_not_observed:'+role);
  };
  let current=await watch(),s=await questState();
  if(!started(current)){
    s=await transition('open','',v=>v.open);
    for(let i=0;i<3&&s.open&&s.panel!=='None'&&s.panel!=='Quests';i++)s=await transition('back','',v=>!v.open||v.panel==='None'||v.panel==='Quests');
    if(!s.open)s=await transition('open','',v=>v.open);
    if(s.panel!=='Quests')s=await transition('menu','Quests',v=>v.open&&v.panel==='Quests');
    for(let attempt=0;attempt<3;attempt++){
      current=await watch();if(started(current))break;
      const r=await q('quest',mission);
      if(!['sent','click_cancelled'].includes(r.input.status))throw Error('quest_input_'+r.input.status);
      current=await watch();if(started(current))break;
    }
    if(!started(current))throw Error('quest_not_started');
  }
  s=await questState();
  for(let i=0;i<4&&s.open;i++){
    const oldPanel=s.panel;
    s=await transition('back','',v=>!v.open||v.panel!==oldPanel);
  }
  if(s.open)throw Error('quest_panel_not_closed');
  return current;
}
export const TARGETS=Object.freeze({
  story_next:'CanvasInterface/StoryboardWindow/Next',story_finish:'CanvasInterface/StoryboardWindow/Finish',
  dialog_continue:'CanvasController/DialogWindow/Content/Buttons/DialogChoiceButton(Clone)',
  craft_open:'CanvasController/PlayerScreen/SafeArea/UIHudInterfaceButtonsPanel/UIHudInterfaceCraft',
  craft_create:'CanvasInterface/Craft/Container/Second/CraftStudiedInfoPanel/ShowRecipePanel/Craft/Craft/UIButtonCraftCommon',
  craft_close:'CanvasInterface/Craft/SafeArea/RootNavigationWidget/CloseButton',
  secondary:'CanvasController/PlayerScreen/SafeArea/UIHudControlsPanel/Buttons/UIControlsButton2',
});

export async function createQuestBridge({mission,session,parameterDirectory}) {
  if(!['intro','control','wooden_hook','shark_attack'].includes(mission)||!isAbsolute(parameterDirectory))throw Error('Unsupported prepared mission or parameter directory');
  await mkdir(parameterDirectory,{recursive:true});
  const [quest,selected,observer,ui,selector,gesture,defenseSource]=await Promise.all([
    spatial('shark-cheat-click.cs.txt'),spatial('selected-control.cs.txt'),local('quest-observer.cs.txt'),
    local('known-quest-ui.cs.txt'),local('select-quest-command.cs.txt'),local('control-gesture.cs.txt'),local('defense-command.cs.txt')]);
  const parameterFile=join(parameterDirectory,'command.params'),questFile=join(parameterDirectory,'quest.params');
  const bindCode=`UnityEditor.SessionState.SetString("QaAgent.PreparedQuest.params",${JSON.stringify(parameterFile)});UnityEditor.SessionState.SetString("QaAgent.QuestUi.params",${JSON.stringify(questFile)});return new{bound=true,input_sent=false};`;
  const codes={quest:session.instrument(quest),questRead:session.instrument(quest.replace('var role=lines[0];','var role="observe";')),
    click:session.instrument(selected),ui:session.instrument(ui),select:selector,gesture:session.instrument(gesture),
    prepare:session.instrument(observerMode(observer,'prepare')),read:session.instrument(observerMode(observer,'read')),
    stop:session.instrument(observerMode(observer,'stop')),defense:session.instrument(defenseSource)};
  let check=()=>{};
  const command=async(code,cleanup=false)=>{if(!cleanup)check();return(await session.batch([exec(code)],{checkErrors:!cleanup}))[0];};
  const select=async(role='',kind='')=>{if(role&&!TARGETS[role])throw Error('Unknown prepared UI role');await writeFile(parameterFile,[mission,TARGETS[role]??'',kind].join('\n'),'utf8');return command(codes.select);};
  const watch=async()=>{const state=await command(codes.read);if(state.status!=='observed')throw Error('quest_source_'+state.status);return state;};
  const questState=async()=>command(codes.questRead);
  const questStatus='return UnityEditor.SessionState.GetString("QaAgent.QuestUi.status","idle");';
  const fastStatus='return UnityEditor.SessionState.GetString("QaAgent.FastUi.status","idle");';
  const motorMode=mode=>`UnityEditor.SessionState.SetString("QaAgent.PreparedControl.v1.mode",${JSON.stringify(mode)});return new{input_sent=false};`;
  const motor=async(mode,cleanup=false)=>{await command(motorMode(mode),cleanup);return command(codes.gesture,cleanup);};
  const defenseAction=async(action,cleanup=false)=>{await writeFile(parameterFile,[mission,'',action].join('\n'),'utf8');return command(codes.defense,cleanup);};
  const q=async(role,target='')=>{
    await writeFile(questFile,role+'\n'+target,'utf8');const ack=await command(codes.quest);
    if(ack.status!=='click_queued')return{input:ack,state:await questState()};
    const until=performance.now()+2600;let status='click_pending';
    while(status==='click_pending'&&performance.now()<until){check();await pause(25);status=await command(questStatus);}
    await pause(1000);check();
    return{input:{status},state:await questState()};
  };
  const click=async role=>{
    await select(role);const ack=await command(codes.click);if(ack.status!=='pending')return ack;
    let status='pending';const until=performance.now()+1000;
    while(status==='pending'&&performance.now()<until){await pause(15);status=await command(fastStatus);}
    return{status};
  };
  const launch=()=>launchKnownQuest({watch,questState,q},mission);
  return {
    setCheck(fn){check=fn;},bind:()=>command(bindCode),watch,ui:()=>command(codes.ui),click,launch,
    async beginWatch(){await command(bindCode);await select();const r=await command(codes.prepare);if(r.status!=='prepared')throw Error('observer_'+r.status);return r;},
    async gesture(kind){
      await select('',kind);let state=await motor('run');const until=performance.now()+1800;
      while(state.status==='running'&&performance.now()<until){await pause(25);state=await motor('snapshot');}
      if(state.status==='running'){await motor('stop',true);throw Error('gesture_timeout');}return state;
    },
    async resetDefense(){
      // The combat delegates are required runtime state, installed only for a real shark mission.
      // Keep the cycle error baseline and stop guard active during their installation.
      const guardedSession={instrument:source=>session.instrument(source),errors:session.errors,
        batch:commands=>session.batch(commands,{checkErrors:true,checkGuard:true})};
      await defense.prepareDefense(guardedSession);
      await command('UnityEditor.SessionState.SetBool("QaAgent.SharkDefense.require_melee",true);return new{input_sent=false};');
      return defenseAction('disarm');
    },
    async startDefense(){const r=await defenseAction('arm');if(r.status==='review_required')throw Error('defense_review_required');return defenseAction('defend');},
    defense:()=>defenseAction('read'),
    async forceAttack(){
      await defenseAction('disarm');let s=await questState();
      if(!s.open)s=(await q('open')).state;
      for(let i=0;i<3&&s.panel!=='None'&&s.panel!=='GamePlay';i++)s=(await q('back')).state;
      if(s.panel!=='GamePlay')s=(await q('menu','GamePlay')).state;
      if(s.panel!=='GamePlay')throw Error('gameplay_panel_not_ready');
      const ack=await q('shark');if(!['sent','click_cancelled'].includes(ack.input.status))throw Error('shark_input_'+ack.input.status);
      s=await questState();for(let i=0;i<4&&s.open;i++)s=(await q('back')).state;
      if(s.open)throw Error('cheat_panel_not_closed');return defenseAction('arm');
    },
    async cancel(){
      if(mission==='control')await motor('stop',true);
      if(mission==='shark_attack')await defenseAction('stop',true);
      await command(codes.stop,true);
    },
    async cleanup(){
      if(mission==='control')await motor('stop',true);
      if(mission==='shark_attack'){
        const state=await defenseAction('read',true);
        await defenseAction(state.busy?'stop':'disarm',true);
      }
      return command(codes.stop,true);
    },
  };
}
