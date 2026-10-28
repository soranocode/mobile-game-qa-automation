import test from 'node:test';
import assert from 'node:assert/strict';
import {MissionPool} from './mission-pool.mjs';
import {runMissionPipeline,verifiedMissionResult} from './pipeline.mjs';
import {CycleJournal} from './cycle-journal.mjs';
import {analyzeCycle} from './cycle-analysis.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tasks=['intro','control','wooden_hook'].map(mission=>({mission,epoch:'current-domain',revision:'reviewed-'+mission}));
const passed=mission=>({mission,result:'PASS_MISSION',input_stopped:true,done:{observed:true,quest_uid:mission,completion_fresh:true,final_complete:true}});
async function fixture(run=async task=>passed(task.mission)){
  const pool=new MissionPool();let active=0,maxActive=0,cancels=0;
  for(const task of tasks)await pool.prepare({...task,factory:async()=>({
    async run(args){active++;maxActive=Math.max(maxActive,active);try{return await run(task,args);}finally{active--; }},
    async cancel(){cancels++;}
  })});
  return{pool,get active(){return active;},get maxActive(){return maxActive;},get cancels(){return cancels;}};
}
const options=f=>({pool:f.pool,tasks,taskId:'current-human-cycle',authorized:true});

test('lookahead prepares the next two tickets during the first run and starts immediately after cleanup',async()=>{
  const release=deferred(),prepared=deferred(),events=[];
  const f=await fixture(async task=>{events.push('run:'+task.mission);if(task.mission==='intro')await release.promise;events.push('cleanup:'+task.mission);return passed(task.mission);});
  const plans=[];
  const cycle=runMissionPipeline({...options(f),prepareTask:async(task,context)=>{
    plans.push({mission:task.mission,active:f.active,keys:Object.keys(context)});
    if(plans.length===3)prepared.resolve();return{task};
  }});
  await prepared.promise;
  assert.deepEqual(plans.map(p=>p.active),[0,1,1]);
  assert.deepEqual(plans[1].keys,['index','signal']);
  assert.deepEqual(events,['run:intro']);release.resolve();
  const result=await cycle;
  assert.equal(result.result,'PASS_SEQUENCE');assert.equal(f.maxActive,1);
  assert.deepEqual(events,['run:intro','cleanup:intro','run:control','cleanup:control','run:wooden_hook','cleanup:wooden_hook']);
  assert.equal(f.pool.cycle,null);assert.equal(f.pool.active,null);
});

test('a cycle retains ownership between missions and rejects live warmup or a second executor',async()=>{
  const paused=deferred(),release=deferred(),f=await fixture();let seen=false;
  const cycle=runMissionPipeline({...options(f),beforeRun:async(_task,{index})=>{if(index===1){seen=true;paused.resolve();await release.promise;}}});
  await paused.promise;assert.equal(seen,true);assert.equal(f.active,0);
  await assert.rejects(f.pool.run({...tasks[0],taskId:'intruder',authorized:true}),/cycle owns input/);
  await assert.rejects(f.pool.prepare({...tasks[1],factory:async()=>{}}),/busy/);
  assert.throws(()=>f.pool.invalidate(),/await/);
  release.resolve();assert.equal((await cycle).result,'PASS_SEQUENCE');
});

test('stop while next preparation is pending cancels current run and discards a late answer',async()=>{
  const started=deferred(),next=deferred(),ended=deferred(),planned=deferred(),stop=new AbortController();
  const ran=[];const f=await fixture(async(task,{signal})=>{
    ran.push(task.mission);
    if(task.mission==='intro'){started.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));ended.resolve();}
    return passed(task.mission);
  });
  const journal=new CycleJournal();
  const cycle=runMissionPipeline({...options(f),signal:stop.signal,journal,lookahead:1,
    prepareTask:async task=>{if(task.mission==='control'){planned.resolve();await next.promise;}return{task};}});
  await started.promise;await planned.promise;stop.abort();await ended.promise;
  const result=await cycle;next.resolve();await Promise.resolve();
  assert.equal(result.result,'STOPPED');assert.deepEqual(ran,['intro']);assert.equal(f.cancels,1);
  assert.equal(journal.events.some(e=>e.type==='plan_ready'&&e.mission==='control'),false);
  assert.equal(f.pool.cycle,null);
});

test('stop racing the first completion cannot admit the second mission',async()=>{
  const stop=new AbortController(),ran=[];
  const f=await fixture(async task=>{ran.push(task.mission);stop.abort();return passed(task.mission);});
  assert.equal((await runMissionPipeline({...options(f),signal:stop.signal})).result,'STOPPED');
  assert.deepEqual(ran,['intro']);
});

test('preparation failure aborts the active owner rather than running stale fallback commands',async()=>{
  const ran=[],f=await fixture(async(task,{signal})=>{
    ran.push(task.mission);await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return passed(task.mission);
  });
  const result=await runMissionPipeline({...options(f),lookahead:1,prepareTask:async task=>{
    if(task.mission==='control')throw Error('reviewed source changed');return{task};
  }});
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/source changed/);
  assert.deepEqual(ran,['intro']);assert.equal(f.cancels,1);
});

test('a different epoch or revision cannot be substituted by a preparer',async()=>{
  const f=await fixture();
  const result=await runMissionPipeline({...options(f),prepareTask:async task=>({task:{...task,revision:'different'}})});
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/changed the approved/);assert.equal(f.maxActive,0);
});

test('source changes after preparation are caught at admission before the next run',async()=>{
  const ran=[],f=await fixture(async task=>{ran.push(task.mission);return passed(task.mission);});
  const result=await runMissionPipeline({...options(f),beforeRun:async(_task,{index})=>{if(index===1)throw Error('Unity epoch changed');}});
  assert.equal(result.result,'NEEDS_REVIEW');assert.deepEqual(ran,['intro']);
});

test('a PASS label without fresh completion and confirmed cleanup does not advance the queue',async()=>{
  const ran=[],f=await fixture(async task=>{ran.push(task.mission);return{mission:task.mission,result:'PASS_MISSION',input_stopped:true};});
  assert.equal((await runMissionPipeline(options(f))).result,'NEEDS_REVIEW');assert.deepEqual(ran,['intro']);
  assert.equal(verifiedMissionResult(tasks[0],{...passed('intro'),input_stopped:false}),false);
});

test('hook completion uses its own 3/3 and cleanup contract',()=>{
  const task={mission:'hook_use'},result={mission:'hook_use',result:'PASS_HOOK_USE',completion:{fresh:true,progress:3,need:3},cleanup:{input_stopped:true,blocked:false,new_errors:0}};
  assert.equal(verifiedMissionResult(task,result),true);
  assert.equal(verifiedMissionResult(task,{...result,completion:{fresh:true,progress:2,need:3}}),false);
  assert.equal(verifiedMissionResult(task,{...result,cleanup:{...result.cleanup,blocked:true}}),false);
});

test('cold handlers are rejected before the first mission, never compiled during the cycle',async()=>{
  const pool=new MissionPool();
  const result=await runMissionPipeline({...options({pool})});
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/Warm all/);assert.equal(pool.cycle,null);
});

test('journal write failure stops the cycle and is not reported as PASS',async()=>{
  const f=await fixture();const journal=new CycleJournal({write:async()=>{throw Error('disk full');}});
  const result=await runMissionPipeline({...options(f),journal});
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/journal failed/);assert.equal(f.pool.cycle,null);
});

test('stream remains ordered across mission boundaries and analysis finalizes once at the end',async()=>{
  const written=[],journal=new CycleJournal({write:async e=>{written.push(e.seq);}}),f=await fixture();let finalized=0,listener;
  const result=await runMissionPipeline({...options(f),journal,subscribe:fn=>{listener=fn;return()=>{listener=null;};},
    beforeRun:async()=>listener({type:'mcp_end',ms:7,tool:'execute_code',id:1,outcomes:[],ok:true}),
    finalize:async({analysis,events})=>{finalized++;assert.equal(events.at(-1).type,'cycle_execution_end');assert.equal(analysis.metrics.mcp_calls,3);return'local-cycle';}});
  assert.equal(result.result,'PASS_SEQUENCE');assert.equal(finalized,1);assert.equal(listener,null);
  assert.deepEqual(written,journal.events.map((_,i)=>i+1));assert.equal(result.evidence_path,'local-cycle');
});

test('analysis generates scoped proposals with evidence rather than rewriting active memory',async()=>{
  let clock=0;const journal=new CycleJournal({now:()=>clock}),f=await fixture();
  const result=await runMissionPipeline({...options(f),journal,prepareTask:async task=>{clock+=200;return{task,knowledge_ids:['CARD-'+task.mission]};}});
  assert.equal(result.result,'PASS_SEQUENCE');assert.equal(result.analysis.active_knowledge_changed,false);
  assert.ok(result.analysis.candidates.length>0);
  for(const c of result.analysis.candidates){assert.equal(c.status,'PROPOSED');assert.deepEqual(c.knowledge_ids,['CARD-'+c.mission]);}
});

test('immutable events and bounded storage protect captured evidence',async()=>{
  const journal=new CycleJournal({maxEvents:1});let faults=0;journal.onFailure(()=>faults++);
  const input={outcomes:[{status:'sent'}]};const event=journal.record('sample',input);input.outcomes[0].status='changed';
  assert.equal(event.outcomes[0].status,'sent');assert.throws(()=>{event.outcomes[0].status='changed';},TypeError);
  journal.record('overflow');assert.equal(faults,1);await assert.rejects(journal.flush(),/limit exceeded/);
});

test('analysis does not turn unlabelled time gaps into inferred model thinking',()=>{
  const analysis=analyzeCycle([{type:'queue_ready',mission:'intro',duration_ms:200,seq:1}],[]);
  assert.equal(analysis.candidates[0].kind,'preparation_delay');assert.match(analysis.causal_limit,/do not establish/);
});

test('a preparation that ignores abort cannot hold the queue indefinitely',async()=>{
  const f=await fixture();
  const result=await runMissionPipeline({...options(f),prepareTimeoutMs:5,prepareTask:()=>new Promise(()=>{})});
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/timed out/);assert.equal(f.maxActive,0);
});

test('asynchronous journal writes do not delay mission handoff',async()=>{
  const disk=deferred(),finished=deferred(),ran=[];
  const f=await fixture(async task=>{ran.push(task.mission);if(ran.length===3)finished.resolve();return passed(task.mission);});
  const journal=new CycleJournal({write:async()=>disk.promise});
  const cycle=runMissionPipeline({...options(f),journal});
  await finished.promise;assert.deepEqual(ran,tasks.map(t=>t.mission));
  disk.resolve();assert.equal((await cycle).result,'PASS_SEQUENCE');
});

test('finalization failure preserves completed outcomes and never replays the cycle',async()=>{
  const ran=[],f=await fixture(async task=>{ran.push(task.mission);return passed(task.mission);});
  const result=await runMissionPipeline({...options(f),finalize:async()=>{throw Error('analysis storage failed');}});
  assert.equal(result.result,'NEEDS_REVIEW');assert.equal(result.results.length,3);
  assert.match(result.reason,/finalization failed/);assert.deepEqual(ran,tasks.map(t=>t.mission));
});

test('an error-monitor event interrupts the owner without waiting for end-of-cycle analysis',async()=>{
  let listener;const ran=[];
  const f=await fixture(async(task,{signal})=>{
    ran.push(task.mission);
    const stopped=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    listener({type:'mcp_end',ms:1,tool:'batch_execute',id:1,ok:true,outcomes:[{blocked:true}]});
    await stopped;return passed(task.mission);
  });
  const result=await runMissionPipeline({...options(f),subscribe:fn=>{listener=fn;return()=>{};}});
  assert.equal(result.result,'NEEDS_REVIEW');assert.match(result.reason,/error monitor/);
  assert.deepEqual(ran,['intro']);assert.equal(f.cancels,1);
});
