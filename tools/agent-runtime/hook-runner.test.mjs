import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareHookHandle,compactHookReport} from './hook-runner.mjs';

function fixture(trial) {
  const events=[];
  const session={active:false,async begin(){events.push('begin');this.active=true;},async finish(){events.push('finish');this.active=false;}};
  const bindings={async prepare(){events.push('bindings.prepare');},async observe(mode){events.push('observe.'+mode);return{};},
    async questUi(){events.push('questUi');},async observeQuestUi(){},async click(){events.push('click');return{status:'sent'};}};
  const aim={async prepare(){events.push('aim.prepare');},async stop(){events.push('aim.stop');},async run(){events.push('aim.run');return{status:'aimed'};}};
  return{events,session,bindings,aim,trial,cycle:{},queue:{}};
}

test('preparation warms only no-input helpers and releases the session',async()=>{
  const f=fixture(async()=>{});await prepareHookHandle(f);
  assert.deepEqual(f.events,['begin','bindings.prepare','aim.prepare','observe.read','aim.stop','observe.stop','finish']);
  assert.equal(f.session.active,false);
});

test('repeat uses warm helpers but fresh observer and report',async()=>{
  const reports=[];const f=fixture(async c=>{reports.push(c.report);await c.aim.run(42);await c.click('use');return{status:'complete'};});
  const handle=await prepareHookHandle(f);const signal=new AbortController().signal;
  await handle.run({signal});await handle.run({signal});
  assert.equal(f.events.filter(e=>e==='bindings.prepare').length,1);
  assert.equal(f.events.filter(e=>e==='aim.prepare').length,1);
  assert.equal(f.events.filter(e=>e==='observe.prepare').length,2);
  assert.notEqual(reports[0],reports[1]);assert.equal(f.session.active,false);
});

test('mission rebinds its parameter files after another mission prepared on the shared session',async()=>{
  const f=fixture(async()=>({status:'complete'}));let binds=0;
  f.rebind=async()=>{binds++;};
  const h=await prepareHookHandle(f);
  await h.run({signal:new AbortController().signal});await h.run({signal:new AbortController().signal});
  assert.equal(binds,3);assert.equal(f.events.filter(e=>e==='bindings.prepare').length,1);
});

test('unknown execution failure is not retried and cleans up',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw Error('transport uncertain');});
  const handle=await prepareHookHandle(f);
  await assert.rejects(handle.run({signal:new AbortController().signal}),/transport uncertain/);
  assert.equal(calls,1);assert.equal(f.session.active,false);assert.equal(f.events.at(-1),'finish');
});

test('cancel blocks the next command and releases owned controllers',async()=>{
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture(async c=>{entered();await gate;await c.click('must-not-click');});
  const handle=await prepareHookHandle(f);
  const running=handle.run({signal:new AbortController().signal});
  await started;await handle.cancel();release();await assert.rejects(running,/Task stopped/);
  assert.equal(f.events.includes('click'),false);assert.equal(f.session.active,false);
});

test('already aborted task never begins or sends input',async()=>{
  const f=fixture(async()=>{throw Error('must not run');});const handle=await prepareHookHandle(f);
  const before=f.events.length,abort=new AbortController();abort.abort();
  await assert.rejects(handle.run({signal:abort.signal}),/Task stopped/);
  assert.equal(f.events.length,before);
});

test('preparation failure releases observer and session',async()=>{
  const f=fixture(async()=>{});f.aim.prepare=async()=>{throw Error('compile failed');};
  await assert.rejects(prepareHookHandle(f),/compile failed/);
  assert.equal(f.session.active,false);assert.equal(f.events.at(-2),'observe.stop');
});

test('full telemetry is saved locally and never returned as the coordinator reply',async()=>{
  let saved;
  const f=fixture(async()=>({status:'complete',trace:['world dump '.repeat(10000)],
    final:{done:{observed:true,completion_fresh:true,final_complete:true,progress_after:3,need:3}},
    session_finish:{stopped:true,error_watch:{available:true,blocked:false,unexpected_new_errors:0,new_errors:0}}}));
  f.saveReport=async report=>{saved=report;return 'local-evidence.json';};
  const handle=await prepareHookHandle(f);
  const result=await handle.run({signal:new AbortController().signal});
  assert.equal(result.result,'PASS_HOOK_USE');assert.ok(saved.trace[0].length>10000);
  assert.ok(JSON.stringify(result).length<1600);assert.equal(result.trace,undefined);
  assert.equal(result.evidence_path,'local-evidence.json');
});

test('old completion or unconfirmed cleanup is not a successful compact result',()=>{
  assert.equal(compactHookReport({status:'complete',final:{done:{observed:true,final_complete:true}}}).result,'NEEDS_REVIEW');
  assert.equal(compactHookReport({status:'complete',final:{done:{observed:true,completion_fresh:true,final_complete:true}}}).result,'NEEDS_REVIEW');
  assert.equal(compactHookReport({status:'complete',final:{done:{observed:true,completion_fresh:true,final_complete:true}},
    session_finish:{stopped:true,error_watch:{available:true,blocked:true,unexpected_new_errors:1}}}).result,'NEEDS_REVIEW');
});
