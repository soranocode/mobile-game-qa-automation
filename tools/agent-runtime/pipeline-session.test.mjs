import test from 'node:test';
import assert from 'node:assert/strict';
import {FastUiSession} from '../unity-ui/session.mjs';
import {MissionPool} from './mission-pool.mjs';
import {runMissionPipeline} from './pipeline.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const passed=mission=>({mission,result:'PASS_MISSION',input_stopped:true,done:{observed:true,quest_uid:mission,completion_fresh:true,final_complete:true}});
function engine(){
  const state={active:false,cycle:false,armed:false,total:0,baseline:0,arms:0,disarms:0,inputs:0,bg:false,lifecycleWarmup:false};
  const watch=()=>({available:true,armed:state.armed,epoch:'same-watcher',blocked:state.armed&&state.total>state.baseline,new_errors:state.total-state.baseline,unexpected_new_errors:state.total-state.baseline});
  const execute=code=>{
    if(code.includes('SetBool("QaAgent.FastUi.lifecycle_warmup",true)')){state.lifecycleWarmup=true;return{input_sent:false};}
    if(code.includes('SetBool("QaAgent.FastUi.lifecycle_warmup",false)')){state.lifecycleWarmup=false;return{input_sent:false};}
    if(state.lifecycleWarmup&&code.includes('lifecycle_warmup'))return{status:'compiled_only',input_sent:false};
    if(code.includes('state["handler"]'))return{installed:true};
    if(code.includes('status="cycle_begun"')){
      if(state.active||state.cycle)return{status:'already_active'};
      state.cycle=true;state.armed=true;state.baseline=state.total;state.arms++;state.bg=true;
      return{status:'cycle_begun',error_watch:watch()};
    }
    if(code.includes('status="cycle_finished"')){
      if(!state.cycle)return{status:'cycle_absent',error_watch:watch()};
      const snapshot=watch();state.cycle=false;state.armed=false;state.disarms++;state.bg=false;
      return{status:'cycle_finished',error_watch:snapshot};
    }
    if(code.includes('status = "begun"')){
      if(code.includes('var heldWatch=')){
        if(!state.armed||watch().blocked)return{status:'blocked_new_error',error_watch:watch()};
      }else{state.armed=true;state.baseline=state.total;state.arms++;}
      state.active=true;return{status:'begun'};
    }
    if(code.includes('stopped = true')){state.active=false;return{stopped:true,error_watch:watch()};}
    if(code.includes('disarmed = true')){state.armed=false;state.disarms++;return{disarmed:true};}
    if(code==='INPUT'){assert.equal(state.armed,true);assert.equal(watch().blocked,false);state.inputs++;return{status:'sent'};}
    return{status:'observed',error_watch:watch()};
  };
  const invoke=async(tool,args)=>{
    const codes=tool==='batch_execute'?args.commands.map(c=>c.params.code):[args.code];
    if(codes.some(code=>code.includes('status="cycle_finished"'))){
      state.endCalls=(state.endCalls??0)+1;
      if(state.pauseEnd){state.endStarted.resolve();await state.pauseEnd.promise;}
    }
    if(state.failEndBefore&&codes.some(code=>code.includes('status="cycle_finished"'))){state.failEndBefore=false;throw Error('Lost cleanup transport');}
    const values=codes.map(execute);
    if(state.failStartAfter&&codes.some(code=>code.includes('status="cycle_begun"'))){state.failStartAfter=false;throw Error('Lost start acknowledgment');}
    if(state.failEndAfter&&codes.some(code=>code.includes('status="cycle_finished"'))){state.failEndAfter=false;throw Error('Lost cleanup acknowledgment');}
    return tool==='batch_execute'?{success:true,data:{results:values.map(result=>({callSucceeded:true,result:{success:true,data:{result}}}))}}:
      {success:true,data:{result:values[0]}};
  };
  return{state,session:new FastUiSession(invoke,'const string role = "__ROLE__";__ERROR_WATCH_SETUP__')};
}
async function setup({missions=['intro','control'],body=async()=>{}}={}){
  const {state,session}=engine(),pool=new MissionPool(),tasks=missions.map(mission=>({mission,epoch:'domain',revision:'source'}));
  for(const task of tasks)await pool.prepare({...task,factory:async()=>({
    async run({signal}){
      try{await session.begin();await body(task,{signal,session,state});await session.invoke('execute_code',{code:'INPUT'});}
      finally{if(session.active)await session.finish();}
      return passed(task.mission);
    },async cancel(){if(session.active)await session.finish();}
  })});
  const options={pool,tasks,authorized:true,taskId:'human-cycle',subscribe:fn=>session.subscribe(fn),guard:fn=>session.guard(fn),claim:token=>session.claimCycle(token)};
  return{state,session,pool,options};
}

test('outside session actions cannot interleave with the cycle or clear its active flag',async()=>{
  const started=deferred(),release=deferred();
  const f=await setup({missions:['intro'],body:async()=>{started.resolve();await release.promise;}});
  const cycle=runMissionPipeline(f.options);await started.promise;
  await assert.rejects(f.session.step('open_menu'),/Cycle owns/);
  await assert.rejects(f.session.finish(),/Cycle owns/);
  await assert.rejects(f.session.invoke('execute_code',{code:'INPUT'}),/Cycle owns/);
  assert.equal(f.session.active,true);assert.equal(f.state.inputs,0);
  release.resolve();assert.equal((await cycle).result,'PASS_SEQUENCE');assert.equal(f.state.inputs,1);
});

test('an error between missions remains visible and blocks the next mission input',async()=>{
  const f=await setup();
  const result=await runMissionPipeline({...f.options,beforeRun:async(_task,{index})=>{
    if(index===1){assert.equal(f.state.armed,true);assert.equal(f.session.active,false);f.state.total++;}
  }});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(f.state.inputs,1);
  assert.equal(f.state.arms,1);assert.equal(f.state.disarms,1);assert.equal(f.state.bg,false);
});

test('late asynchronous work from a released owner cannot send another command',async()=>{
  const trigger=deferred();let late;
  const f=await setup({missions:['intro'],body:async(_task,{session})=>{late=trigger.promise.then(()=>session.invoke('execute_code',{code:'INPUT'}));}});
  assert.equal((await runMissionPipeline(f.options)).result,'PASS_SEQUENCE');
  trigger.resolve();await assert.rejects(late,/expired/);assert.equal(f.state.inputs,1);
});

test('cycle starts with its actual owner without a preliminary warming call',async()=>{
  const {state,session}=engine();
  assert.equal(state.arms,0);assert.equal(state.disarms,0);assert.equal(state.cycle,false);assert.equal(state.inputs,0);
  const owner=session.claimCycle(Symbol('actual-cycle'));
  await owner.begin();assert.equal(state.arms,1);assert.equal(state.cycle,true);assert.equal(state.inputs,0);
  await owner.finish();owner.release();assert.equal(state.armed,false);assert.equal(state.cycle,false);
});

test('external stop can execute scoped cleanup while blocking the remaining input',async()=>{
  const started=deferred(),stop=new AbortController();
  const f=await setup({missions:['intro'],body:async(_task,{signal})=>{
    started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  }});
  const cycle=runMissionPipeline({...f.options,signal:stop.signal});await started.promise;stop.abort();
  const result=await cycle;
  assert.equal(result.result,'STOPPED');assert.equal(f.state.inputs,0);assert.equal(f.state.cycle,false);
  assert.equal(f.state.armed,false);assert.equal(f.session.cycleActive,false);assert.equal(f.pool.active,null);
});

test('lookahead runs outside the input owner scope even if a planner captures the session',async()=>{
  const f=await setup();let blocked=false;
  const result=await runMissionPipeline({...f.options,prepareTask:async task=>{
    if(task.mission==='control'){
      await assert.rejects(f.session.invoke('execute_code',{code:'INPUT'}),/Cycle owns/);blocked=true;
    }
    return{task};
  }});
  assert.equal(result.result,'PASS_SEQUENCE');assert.equal(blocked,true);assert.equal(f.state.inputs,2);
});

test('completed mission callbacks lose input authority before the next mission',async()=>{
  const trigger=deferred(),second=deferred(),release=deferred();let late;
  const f=await setup({body:async(task,{session})=>{
    if(task.mission==='intro')late=trigger.promise.then(()=>session.invoke('execute_code',{code:'INPUT'}));
    else{second.resolve();await release.promise;}
  }});
  const cycle=runMissionPipeline(f.options);await second.promise;
  trigger.resolve();await assert.rejects(late,/expired/);assert.equal(f.state.inputs,1);
  release.resolve();assert.equal((await cycle).result,'PASS_SEQUENCE');assert.equal(f.state.inputs,2);
});

test('lost cycle start acknowledgment is reconciled before releasing the lease',async()=>{
  const f=await setup();f.state.failStartAfter=true;
  const result=await runMissionPipeline(f.options);
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(result.cleanup_confirmed,true);
  assert.equal(f.state.inputs,0);assert.equal(f.state.cycle,false);assert.equal(f.state.armed,false);
  assert.equal(f.pool.cycle,null);assert.equal(f.session.cycleActive,false);
});

for(const fault of ['failEndBefore','failEndAfter'])test(fault+' retains ownership until explicit cleanup confirmation',async()=>{
  const f=await setup({missions:['intro']});f.state[fault]=true;
  const result=await runMissionPipeline(f.options);
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(result.cleanup_confirmed,false);
  assert.ok(f.pool.cycle);assert.equal(f.session.cycleActive,true);
  await assert.rejects(f.session.invoke('execute_code',{code:'INPUT'}),/Cycle owns/);
  assert.throws(()=>f.pool.acquireCycle('another'),/busy/);
  await f.session.recoverStoppedCycle();f.pool.releaseCycle(f.pool.cycle.token);
  assert.equal(f.state.cycle,false);assert.equal(f.state.armed,false);assert.equal(f.pool.cycle,null);
  assert.equal(f.session.cycleActive,false);assert.equal(f.state.inputs,1);
});

test('concurrent recovery requests share one cleanup and cannot release a later owner',async()=>{
  const f=await setup({missions:['intro']});f.state.failEndBefore=true;
  await runMissionPipeline(f.options);
  f.state.pauseEnd=deferred();f.state.endStarted=deferred();
  const first=f.session.recoverStoppedCycle();await f.state.endStarted.promise;
  const second=f.session.recoverStoppedCycle();
  assert.equal(f.state.endCalls,2);f.state.pauseEnd.resolve();
  await Promise.all([first,second]);f.pool.releaseCycle(f.pool.cycle.token);
  const next=f.session.claimCycle(Symbol('new-cycle'));
  assert.equal(f.session.cycleActive,true);assert.equal(f.state.endCalls,2);
  next.release();
});
