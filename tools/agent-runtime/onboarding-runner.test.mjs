import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareQuestHandle,prepareIntroMission,prepareControlMission,prepareWoodenHookMission,prepareSharkAttackMission} from './onboarding-runner.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MissionPool,getMissionPool,runMissionSequence} from './mission-pool.mjs';
import {launchKnownQuest} from './quest-bridge.mjs';

function fixture(mission,{neverDone=false,shortMovement=false,noAttack=false}={}){
  const events=[];let time=0,page=0,done=false,craft=false,movement=false,camera=false,fightReads=0;
  let checker=()=>{};
  const steps=()=>mission==='control'?[{uid:'movement',complete:movement},{uid:'camera',complete:camera}]:[{uid:mission,complete:done}];
  const snapshot=()=>({active:!done,steps:steps(),done:done&&!neverDone?{observed:true,quest_uid:mission,completion_fresh:true,final_complete:true,steps:steps()}:null});
  const session={active:false,async begin(){events.push('begin');this.active=true;},async finish(){events.push('finish');this.active=false;return{stopped:true,error_watch:{available:true,blocked:false,unexpected_new_errors:0}};}};
  const bridge={
    setCheck(fn){checker=fn;},async prepare(){events.push('prepare');},async beginWatch(){events.push('watch.prepare');},
    async cleanup(){events.push('cleanup');},async cancel(){events.push('cancel');},
    async launch(){checker();events.push('launch:'+mission);},async watch(){checker();return snapshot();},
    async ui(){return{story_identity:'page-'+page,story_next:mission==='intro'&&page<2,story_finish:mission==='intro'&&page===2,
      dialog_continue:false,craft_open:craft,craft_create:craft,primary:'Hook',secondary:''};},
    async click(role){checker();events.push(role);
      if(role==='story_next')page++;
      if(role==='story_finish'){page++;done=true;}
      if(role==='craft_open')craft=true;
      if(role==='craft_close'){craft=false;done=true;}
      return{status:'sent'};
    },
    async gesture(kind){checker();events.push(kind);
      if(kind==='move')movement=true;else{camera=true;done=true;}
      return{status:'completed',released:true,displacement:shortMovement?.00155:.04,look_degrees:1.2};
    },
    async resetDefense(){events.push('defense.reset');},async startDefense(){events.push('defense.start');},
    async defense(){fightReads++;if(noAttack)return{status:'sleeping',busy:false,attack_epoch:0,outcome:'none'};
      if(fightReads>1){done=true;return{status:'sleeping',busy:false,attack_epoch:1,outcome:'repelled'};}
      return{status:'aiming',busy:true,attack_epoch:1,outcome:'in_progress'};
    },async forceAttack(){events.push('force_attack');},
  };
  const f={mission,session,bridge,events,now:()=>time,wait:async ms=>{time+=ms;},saveReport:async()=> 'local-report.json'};
  return f;
}
const run=async f=>{const handler=await prepareQuestHandle(f);return{handler,result:await handler.run({signal:new AbortController().signal})};};

test('intro registration sends no Unity commands; run uses Next and Finish with fresh Done',async()=>{
  const f=fixture('intro');const h=await prepareQuestHandle(f);
  assert.deepEqual(f.events,[]);
  const r=await h.run({signal:new AbortController().signal});
  assert.equal(r.result,'PASS_MISSION');assert.deepEqual(f.events.filter(x=>x.startsWith('story_')),['story_next','story_next','story_finish']);
});

test('wooden_hook registers without Unity calls and keeps fresh completion and single Create',async()=>{
  const f=fixture('wooden_hook');const h=await prepareQuestHandle(f);
  assert.deepEqual(f.events,[]);assert.equal(h.preparation_mode,'on_demand');
  const result=await h.run({signal:new AbortController().signal});
  assert.equal(result.result,'PASS_MISSION');assert.equal(f.events.includes('prepare'),false);
  assert.equal(f.events.filter(x=>x==='craft_create').length,1);assert.equal(f.session.active,false);
});

test('all actual onboarding factories bind local parameters without touching the transport',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ocean-cold-factory-'));
  try{
    const session={active:false,instrument:source=>source,async batch(){throw Error('No Unity calls during cold handle creation');}};
    for(const [name,factory] of Object.entries({intro:prepareIntroMission,control:prepareControlMission,wooden_hook:prepareWoodenHookMission,shark_attack:prepareSharkAttackMission})){
      const parameters=join(directory,name),handler=await factory({session,parameterDirectory:parameters});
      assert.equal(handler.preparation_mode,'on_demand');assert.equal(await readFile(join(parameters,'quest.params'),'utf8'),'observe\n');
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('on-demand execution still stops unknown input and does not omit cleanup',async()=>{
  const f=fixture('wooden_hook');let clicks=0;f.bridge.click=async()=>{clicks++;return{status:'pending'};};
  const h=await prepareQuestHandle(f);
  const result=await h.run({signal:new AbortController().signal});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(clicks,1);assert.equal(result.input_stopped,true);
});
test('Finish acknowledgement alone cannot finish intro',async()=>{
  const {result}=await run(fixture('intro',{neverDone:true}));
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/completion_not_observed/);
});

test('intro switches straight to Finish when the last Next disappears before its click',async()=>{
  const f=fixture('intro'),ui=f.bridge.ui,click=f.bridge.click;
  let changed=false;
  f.bridge.ui=async()=>changed?{story_identity:'last',story_next:false,story_finish:true}:ui();
  f.bridge.click=async role=>{
    if(role==='story_next'&&!changed){changed=true;return{status:'not_sent',reason:'Expected one current UI target',matches:0};}
    return click(role);
  };
  const {result}=await run(f);
  assert.equal(result.result,'PASS_MISSION');
  assert.deepEqual(f.events.filter(x=>x.startsWith('story_')),['story_finish']);
  assert.equal(f.events.filter(x=>x==='launch:intro').length,1);
});

test('intro reselects Finish after a queued Next target changes without sending input',async()=>{
  const f=fixture('intro'),click=f.bridge.click;let changed=false;
  f.bridge.ui=async()=>({story_identity:changed?'last':'before-last',story_next:!changed,story_finish:changed});
  f.bridge.click=async role=>{
    if(!changed){changed=true;return{status:'not_sent_target_changed'};}
    return click(role);
  };
  assert.equal((await run(f)).result.result,'PASS_MISSION');
  assert.deepEqual(f.events.filter(x=>x.startsWith('story_')),['story_finish']);
});

test('intro still stops when a story target is ambiguous rather than replaced',async()=>{
  const f=fixture('intro');let clicks=0;
  f.bridge.click=async()=>{clicks++;return{status:'not_sent',reason:'Expected one current UI target',matches:2};};
  const {result}=await run(f);
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(clicks,1);
});

test('accepted repeated Finish during fade still requires a fresh Done',async()=>{
  const f=fixture('intro'),watch=f.bridge.watch,ui=f.bridge.ui,click=f.bridge.click;let reads=0,finishes=0;
  f.bridge.watch=async()=>{const s=await watch();if(s.done&&++reads<4)return{...s,done:null};return s;};
  f.bridge.ui=async()=>finishes===1?{story_identity:'fading',story_next:false,story_finish:true}:ui();
  f.bridge.click=async role=>{if(role==='story_finish')finishes++;return click(role);};
  assert.equal((await run(f)).result.result,'PASS_MISSION');
  assert.equal(f.events.filter(x=>x==='story_finish').length,2);
});
test('known covered control is retried locally, no whole mission replay',async()=>{
  const f=fixture('intro');const click=f.bridge.click;let blocked=2;
  f.bridge.click=async role=>blocked-->0?{status:'not_sent_covered'}:click(role);
  assert.equal((await run(f)).result.result,'PASS_MISSION');
  assert.equal(f.events.filter(x=>x==='launch:intro').length,1);
});
test('control performs actual movement and camera gestures, requiring both steps',async()=>{
  const f=fixture('control');const {result}=await run(f);
  assert.equal(result.result,'PASS_MISSION');assert.deepEqual(f.events.filter(x=>['move','look'].includes(x)),['move','look']);
  assert.equal(result.done.steps.length,2);
});
test('a short movement counted by the tutorial is accepted without an additional move',async()=>{
  const f=fixture('control',{shortMovement:true});const {result}=await run(f);
  assert.equal(result.result,'PASS_MISSION');assert.equal(f.events.filter(e=>e==='move').length,1);
  assert.equal(f.events.filter(e=>e==='look').length,1);
});

test('a released movement timeout that completed its current quest step proceeds to Look',async()=>{
  const f=fixture('control',{shortMovement:true}),gesture=f.bridge.gesture;
  f.bridge.gesture=async kind=>({...await gesture(kind),status:kind==='move'?'timeout':'completed'});
  const {result}=await run(f);assert.equal(result.result,'PASS_MISSION');
  assert.deepEqual(f.events.filter(e=>['move','look'].includes(e)),['move','look']);
});

test('movement timeout without fresh step completion still stops',async()=>{
  const f=fixture('control');let gestures=0;
  f.bridge.gesture=async()=>{gestures++;return{status:'timeout',released:true};};
  const {result}=await run(f);assert.equal(result.result,'NEEDS_REVIEW');
  assert.match(result.reason,/control_timeout/);assert.equal(gestures,1);
});

test('an unknown movement outcome is not excused by a counted step',async()=>{
  const f=fixture('control'),gesture=f.bridge.gesture;let calls=0;
  f.bridge.gesture=async kind=>{calls++;return{...await gesture(kind),status:'pending'};};
  const {result}=await run(f);assert.equal(result.result,'NEEDS_REVIEW');assert.equal(calls,1);
});

test('completed gestures alone do not replace the final quest step result',async()=>{
  const f=fixture('control'),gesture=f.bridge.gesture;
  f.bridge.gesture=async kind=>kind==='move'?{status:'completed',released:true,displacement:.02}:gesture(kind);
  const {result}=await run(f);assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/control_steps_incomplete/);
});
test('wooden_hook uses Create once, then closes the window before checking Done',async()=>{
  const f=fixture('wooden_hook');const {result}=await run(f);
  assert.equal(result.result,'PASS_MISSION');assert.deepEqual(f.events.filter(x=>x.startsWith('craft_')),['craft_open','craft_create','craft_close']);
});
test('sent craft is not blindly repeated when completion is delayed or missing',async()=>{
  const f=fixture('wooden_hook',{neverDone:true});const {result}=await run(f);
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(f.events.filter(x=>x==='craft_create').length,1);
});
test('shark mission requires combat retreat AND fresh quest completion',async()=>{
  const f=fixture('shark_attack');const {result}=await run(f);
  assert.equal(result.result,'PASS_MISSION');assert.ok(f.events.indexOf('defense.start')>f.events.indexOf('launch:shark_attack'));
  assert.equal(f.events.includes('force_attack'),false);
  assert.equal((await run(fixture('shark_attack',{neverDone:true}))).result.result,'NEEDS_REVIEW');
});
test('no attack does not pass, reset progress, or invoke a cheat without the explicit option',async()=>{
  const f=fixture('shark_attack',{noAttack:true});const {result}=await run(f);
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/not_repelled/);
  assert.equal(f.events.includes('force_attack'),false);
});
test('explicit attack cheat retry is bounded to once',async()=>{
  const f=fixture('shark_attack',{noAttack:true});const h=await prepareQuestHandle(f);
  await h.run({signal:new AbortController().signal,input:{allowAttackCheat:true}});
  assert.equal(f.events.filter(x=>x==='force_attack').length,1);
});
test('repeats reuse preparation with a fresh observer and release input',async()=>{
  const f=fixture('wooden_hook');const h=await prepareQuestHandle(f);
  await h.run({signal:new AbortController().signal});await h.run({signal:new AbortController().signal});
  assert.equal(f.events.filter(x=>x==='prepare').length,0);assert.equal(f.events.filter(x=>x==='watch.prepare').length,2);
  assert.equal(f.session.active,false);
});
test('unknown click outcome stops immediately without another click',async()=>{
  const f=fixture('intro');let clicks=0;f.bridge.click=async()=>{clicks++;return{status:'pending'};};
  const {result}=await run(f);assert.equal(result.result,'NEEDS_REVIEW');assert.equal(clicks,1);assert.equal(f.session.active,false);
});
test('stable pool lookup survives changed caller variable names',()=>{
  const host={};assert.equal(getMissionPool(host),getMissionPool(host));assert.notEqual(getMissionPool({}),getMissionPool(host));
});
test('sequence checks all preparations before starting and never advances after failure',async()=>{
  const pool=new MissionPool();let runs=0;
  const first={mission:'intro',epoch:'e',revision:'r'},second={mission:'control',epoch:'e',revision:'r'};
  await pool.prepare({...first,factory:async()=>({run:async()=>{runs++;return{result:'NEEDS_REVIEW'};},cancel:async()=>{}})});
  await assert.rejects(runMissionSequence(pool,{tasks:[first,second],taskId:'suite',authorized:true}),/incomplete/);assert.equal(runs,0);
  await pool.prepare({...second,factory:async()=>({run:async()=>{runs++;return{result:'PASS_MISSION'};},cancel:async()=>{}})});
  const result=await runMissionSequence(pool,{tasks:[first,second],taskId:'suite',authorized:true});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(runs,1);
});

test('an active quest is adopted and never started a second time',async()=>{
  const actions=[];let s={open:true,panel:'Quests'};
  await launchKnownQuest({watch:async()=>({active:true}),questState:async()=>s,q:async(role)=>{actions.push(role);s=s.panel==='Quests'?{open:true,panel:'None'}:{open:false,panel:'None'};return{input:{status:'sent'},state:s};}},'shark_attack');
  assert.deepEqual(actions,['back','back']);assert.equal(s.open,false);
});
test('cancelled gestures are retried by fresh panel state, not by restarting the whole mission',async()=>{
  const actions=[];let active=false,openAttempts=0,s={open:false,panel:'None'};
  await launchKnownQuest({watch:async()=>({active}),questState:async()=>s,q:async(role)=>{
    actions.push(role);
    if(role==='open'&&openAttempts++===0)return{input:{status:'click_cancelled'},state:s};
    if(role==='open')s={open:true,panel:'None'};
    if(role==='menu')s={open:true,panel:'Quests'};
    if(role==='quest')active=true;
    if(role==='back')s=s.panel==='Quests'?{open:true,panel:'None'}:{open:false,panel:'None'};
    return{input:{status:role==='quest'?'click_cancelled':'sent'},state:s};
  }},'intro');
  assert.equal(actions.filter(a=>a==='open').length,2);assert.equal(actions.filter(a=>a==='quest').length,1);
});

test('user stop during a sequence cancels the owner and does not start the next mission',async()=>{
  const pool=new MissionPool(),stop=new AbortController();let cancelled=false,secondStarted=false;
  const a={mission:'intro',epoch:'e',revision:'r'},b={mission:'control',epoch:'e',revision:'r'};
  await pool.prepare({...a,factory:async()=>({run:async()=>{stop.abort();return{result:'NEEDS_REVIEW'};},cancel:async()=>{cancelled=true;}})});
  await pool.prepare({...b,factory:async()=>({run:async()=>{secondStarted=true;return{result:'PASS_MISSION'};},cancel:async()=>{}})});
  const r=await runMissionSequence(pool,{tasks:[a,b],authorized:true,taskId:'suite',signal:stop.signal});
  assert.equal(r.result,'STOPPED');assert.equal(cancelled,true);assert.equal(secondStarted,false);
});
