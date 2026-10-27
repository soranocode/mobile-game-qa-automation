import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestBridge} from './quest-bridge.mjs';
export const MISSIONS=Object.freeze(['intro','control','wooden_hook','shark_attack']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const retryable=new Set(['not_sent_covered','not_sent_blocked','control_covered','control_unavailable']);
export const freshDone=(s,uid)=>s?.done?.observed===true&&s.done.quest_uid===uid&&s.done.completion_fresh===true&&s.done.final_complete===true;

async function clickKnown(c,role){
  for(let i=0;i<5;i++){
    c.check();const result=await c.bridge.click(role);c.report.actions.push({role,status:result.status});
    if(result.status==='sent')return true;
    // Next can be replaced by Finish between observing the page and sending input.
    // These outcomes prove that no click was sent: reselect the current story control.
    if((role==='story_next'||role==='story_finish')&&
      (result.status==='not_sent_target_changed'||
       (result.status==='not_sent'&&result.reason==='Expected one current UI target'&&result.matches===0)))return false;
    if(!retryable.has(result.status))throw Error('input_outcome_'+result.status);
    await c.wait(100);
  }throw Error('known_control_blocked:'+role);
}
async function closeDialogs(c){
  for(let i=0;i<4;i++){c.check();if(!(await c.bridge.ui()).dialog_continue)return;await clickKnown(c,'dialog_continue');await c.wait(100);}
  if((await c.bridge.ui()).dialog_continue)throw Error('dialog_not_closed');
}
async function awaitDone(c,timeout=2500){
  const end=c.now()+timeout;
  while(c.now()<end){c.check();const s=await c.bridge.watch();if(freshDone(s,c.mission))return s;await c.wait(100);}
  throw Error('fresh_quest_completion_not_observed');
}

export async function runPreparedQuest(c){
  if(c.mission==='shark_attack'){
    // Equipment is checked before activation; no direct equip, freecraft or game reset.
    const gear=await c.bridge.ui();
    if(gear.primary!=='Hook'){
      if(gear.secondary!=='Hook')throw Error('hook_required_for_melee');
      await clickKnown(c,'secondary');
      if((await c.bridge.ui()).primary!=='Hook')throw Error('hook_switch_not_confirmed');
    }
    await c.bridge.resetDefense();
  }
  await c.bridge.launch();
  c.report.launch_ms=c.now()-c.started;
  if(c.mission==='intro'){
    let lastIdentity=null,lastRole=null;
    for(let i=0;i<30;i++){
      c.check();const state=await c.bridge.watch();if(freshDone(state,c.mission))return state;
      const ui=await c.bridge.ui();const role=ui.story_finish?'story_finish':ui.story_next?'story_next':null;
      if(!role){await c.wait(100);continue;}
      // An unchanged page is observed briefly before the same non-destructive Next is retried.
      if(lastIdentity===ui.story_identity&&lastRole===role)await c.wait(120);
      const sent=await clickKnown(c,role);
      if(!sent){lastIdentity=null;lastRole=null;continue;}
      lastIdentity=ui.story_identity;lastRole=role;
      await c.wait(100);
    }
    return awaitDone(c);
  }
  await closeDialogs(c);
  if(c.mission==='control'){
    for(const step of ['movement','camera']){
      let state=await c.bridge.watch();
      if(freshDone(state,c.mission))break;
      if(state.steps?.some(s=>s.uid===step&&s.complete))continue;
      await closeDialogs(c);
      let gesture;
      for(let i=0;i<5;i++){
        c.check();gesture=await c.bridge.gesture(step==='movement'?'move':'look');
        c.report.actions.push({role:step,status:gesture.status});
        if(gesture.status==='completed')break;
        if(!retryable.has(gesture.status))throw Error('control_'+gesture.status);
        await c.wait(100);
      }
      if(gesture.status!=='completed')throw Error('control_not_ready');
      if(step==='movement'&&!(gesture.displacement>.005))throw Error('movement_not_observed');
      if(step==='camera'&&!(gesture.look_degrees>.01))throw Error('camera_change_not_observed');
      await c.wait(100);
    }
    const done=await awaitDone(c);
    if(!['movement','camera'].every(uid=>done.done.steps?.some(s=>s.uid===uid&&s.complete)))throw Error('control_steps_incomplete');
    return done;
  }
  if(c.mission==='wooden_hook'){
    if(!(await c.bridge.ui()).craft_open)await clickKnown(c,'craft_open');
    await clickKnown(c,'craft_create'); // The quest focuses WoodenHook; no recipe research or reselection.
    await clickKnown(c,'craft_close');  // Done can be delivered only after the window closes.
    return awaitDone(c);
  }
  if(c.mission==='shark_attack'){
    await c.bridge.startDefense();let began=c.now(),forced=false;
    while(c.now()-began<45000){
      c.check();const fight=await c.bridge.defense();c.report.defense=fight;
      if(fight.status==='needs_review'||(fight.outcome&&!['none','in_progress','repelled'].includes(fight.outcome)))throw Error('defense_'+fight.outcome);
      if(fight.outcome==='repelled')return awaitDone(c);
      // A requested cheat retry is explicit input, not an automatic re-start of the active quest.
      if(c.input?.allowAttackCheat===true&&!forced&&!fight.busy&&fight.attack_epoch===0&&c.now()-began>4000){
        await c.bridge.forceAttack();await c.bridge.startDefense();forced=true;
      }
      await c.wait(250);
    }throw Error('shark_attack_not_repelled');
  }
  throw Error('unsupported_prepared_mission');
}

export async function prepareQuestHandle({mission,session,bridge,saveReport=async()=>null,wait=sleep,now=()=>performance.now()}){
  if(!MISSIONS.includes(mission)||session.active)throw Error('Supported mission and idle single executor required');
  await session.begin();
  try{await bridge.prepare();}finally{try{await bridge.cleanup();}finally{if(session.active)await session.finish();}}
  let running=false,stopped=false;
  return{
    async run({signal,input}){
      if(running||session.active)throw Error('Executor busy');
      if(signal.aborted)throw Error('Task stopped');
      running=true;stopped=false;const started=now(),report={mission,actions:[],started_utc:new Date().toISOString()};
      const check=()=>{if(stopped||signal.aborted)throw Error('Task stopped');if(now()-started>65000)throw Error('mission_timeout');};
      bridge.setCheck(check);let failure,final;
      try{await session.begin();await bridge.beginWatch();check();final=await runPreparedQuest({mission,bridge,input,report,started,check,wait,now});}
      catch(e){failure=e;report.error=String(e);}
      finally{
        bridge.setCheck(()=>{});
        try{report.observer_cleanup=await bridge.cleanup();}catch(e){failure??=e;}
        try{if(session.active)report.cleanup=await session.finish();}catch(e){failure??=e;}
        running=false;
      }
      report.final=final;report.run_ms=now()-started;
      if(failure)report.error=String(failure);
      const path=await saveReport(report);const watch=report.cleanup?.error_watch;
      const passed=!failure&&freshDone(final,mission)&&report.cleanup?.stopped===true&&watch?.available===true&&watch?.blocked===false&&watch?.unexpected_new_errors===0;
      return{mission,result:passed?'PASS_MISSION':'NEEDS_REVIEW',done:final?.done??null,
        launch_ms:report.launch_ms??null,run_ms:report.run_ms,actions:report.actions.length,
        reason:failure?String(failure).slice(0,300):null,input_stopped:report.cleanup?.stopped===true,evidence_path:path};
    },
    async cancel(){stopped=true;try{await bridge.cancel();}finally{if(session.active)await session.finish();}},
  };
}

export async function prepareOnboardingMission({mission,session,parameterDirectory}){
  const bridge=await createQuestBridge({mission,session,parameterDirectory});
  const evidence=join(parameterDirectory,'evidence');
  const saveReport=async report=>{await mkdir(evidence,{recursive:true});const path=join(evidence,Date.now()+'-'+randomUUID()+'.json');await writeFile(path,JSON.stringify(report,null,2),'utf8');return path;};
  return prepareQuestHandle({mission,session,bridge,saveReport});
}
export const prepareIntroMission=options=>prepareOnboardingMission({...options,mission:'intro'});
export const prepareControlMission=options=>prepareOnboardingMission({...options,mission:'control'});
export const prepareWoodenHookMission=options=>prepareOnboardingMission({...options,mission:'wooden_hook'});
export const prepareSharkAttackMission=options=>prepareOnboardingMission({...options,mission:'shark_attack'});
