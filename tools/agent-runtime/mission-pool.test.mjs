import test from 'node:test';
import assert from 'node:assert/strict';
import {MissionPool} from './mission-pool.mjs';

const key={mission:'hook_use',epoch:'unity-domain-1',revision:'reviewed-sources-1'};
const request={...key,taskId:'human-task-1',authorized:true,input:{targetIds:[42]}};

test('warm reuse does not prepare again or retain runtime input',async()=>{
  const pool=new MissionPool();let prepares=0,runs=0;
  const factory=async()=>{prepares++;return{run:async({input})=>{runs++;return input.targetIds;},cancel:async()=>{}};};
  assert.equal((await pool.prepare({...key,factory})).prepared_now,true);
  assert.equal((await pool.prepare({...key,factory})).prepared_now,false);
  assert.deepEqual(await pool.run(request),[42]);
  assert.deepEqual(await pool.run({...request,taskId:'human-task-2',input:{targetIds:[99]}}),[99]);
  assert.equal(prepares,1);assert.equal(runs,2);assert.equal(pool.active,null);
  assert.equal([...pool.prepared.values()][0].input,undefined);
});

test('Unity reload and source revision cannot reuse old commands',async()=>{
  const pool=new MissionPool();await pool.prepare({...key,factory:async()=>({run:async()=>{},cancel:async()=>{}})});
  await assert.rejects(pool.run({...request,epoch:'new-domain'}),/Preparation required/);
  await assert.rejects(pool.run({...request,revision:'new-source'}),/Preparation required/);
});

test('preparation does not authorize later execution',async()=>{
  const pool=new MissionPool();await pool.prepare({...key,factory:async()=>({run:async()=>{},cancel:async()=>{}})});
  await assert.rejects(pool.run({...request,authorized:false}),/Fresh scoped user task/);
  await assert.rejects(pool.run({...request,taskId:''}),/Fresh scoped user task/);
});

test('one executor owns input, including cancellation',async()=>{
  const pool=new MissionPool();let finish,cancelled=false;
  const done=new Promise(resolve=>{finish=resolve;});
  await pool.prepare({...key,factory:async()=>({run:async({signal})=>{await done;return signal.aborted;},cancel:async()=>{cancelled=true;}})});
  const running=pool.run(request);
  await assert.rejects(pool.run({...request,taskId:'other'}),/Executor busy/);
  await assert.rejects(pool.prepare({...key,factory:async()=>{}}),/Executor busy/);
  assert.equal((await pool.stop()).status,'stop_requested');assert.equal(cancelled,true);
  await assert.rejects(pool.run({...request,taskId:'too-early'}),/Executor busy/);
  finish();assert.equal(await running,true);assert.equal(pool.active,null);
});

test('preparation and execution failures do not cause automatic retries',async()=>{
  const pool=new MissionPool();let attempts=0;
  await assert.rejects(pool.prepare({...key,factory:async()=>{throw Error('compile failed');}}),/compile failed/);
  assert.equal(pool.preparing,false);assert.equal(pool.prepared.size,0);
  await pool.prepare({...key,factory:async()=>({run:async()=>{attempts++;throw Error('unknown input outcome');},cancel:async()=>{}})});
  await assert.rejects(pool.run(request),/unknown input outcome/);
  assert.equal(attempts,1);assert.equal(pool.active,null);
});

test('new revision replaces old closures and invalidation clears warmth',async()=>{
  const pool=new MissionPool(),factory=async()=>({run:async()=>{},cancel:async()=>{}});
  await pool.prepare({...key,factory});await pool.prepare({...key,revision:'revision-2',factory});
  assert.equal(pool.prepared.size,1);pool.invalidate();assert.equal(pool.prepared.size,0);
});

test('a cycle lease survives the end of run until cancellation cleanup settles',async()=>{
  const pool=new MissionPool();let ended,cancelled;
  const runEnd=new Promise(resolve=>{ended=resolve;}),cancelEnd=new Promise(resolve=>{cancelled=resolve;});
  await pool.prepare({...key,factory:async()=>({run:async()=>{await runEnd;return{};},cancel:()=>cancelEnd})});
  const lease=pool.acquireCycle('cycle');const run=pool.run({...request,lease:lease.token});
  const stop=pool.stop();ended();await Promise.resolve();await Promise.resolve();
  assert.notEqual(pool.active,null);assert.throws(()=>pool.releaseCycle(lease.token),/cleanup/);
  cancelled();await stop;await run;pool.releaseCycle(lease.token);
  await assert.rejects(pool.run({...request,lease:lease.token}),/expired/);
});

test('a failed handler is cancelled before its input lease is released',async()=>{
  const pool=new MissionPool();let cancelled=0;
  await pool.prepare({...key,factory:async()=>({run:async()=>{throw Error('unknown transport outcome');},cancel:async()=>{assert.notEqual(pool.active,null);cancelled++;}})});
  await assert.rejects(pool.run(request),/unknown transport outcome/);
  assert.equal(cancelled,1);assert.equal(pool.active,null);
});
