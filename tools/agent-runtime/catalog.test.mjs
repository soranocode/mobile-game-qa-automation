import test from 'node:test';
import assert from 'node:assert/strict';
import {isAbsolute,join} from 'node:path';
import {prepareSelectedMissions,executePreparedPipeline} from './catalog.mjs';
import {MissionPool} from './mission-pool.mjs';

test('selected missions prepare once each on the same executor and distinct parameter files',async()=>{
  const pool=new MissionPool(),calls=[],session={guarded:true};
  const tasks=['intro','control','wooden_hook','hook_use','canned_eat','shark_attack'].map(mission=>({mission,epoch:'current-domain',revision:'reviewed-'+mission}));
  const factories=Object.fromEntries(tasks.map(t=>[t.mission,async args=>{calls.push({mission:t.mission,...args});return{run:async()=>({result:'PASS_MISSION'}),cancel:async()=>{}};}]));
  const directory=join(import.meta.dirname,'local-parameters');
  const options={tasks,session,parameterDirectory:directory,pool,factories};
  assert.equal((await prepareSelectedMissions(options)).prepared.every(t=>t.ready),true);
  assert.equal((await prepareSelectedMissions(options)).prepared.every(t=>!t.prepared_now),true);
  assert.equal(calls.length,tasks.length);assert.equal(calls.every(c=>c.session===session&&isAbsolute(c.parameterDirectory)),true);
  assert.equal(new Set(calls.map(c=>c.parameterDirectory)).size,tasks.length);
  assert.equal(calls.every(c=>!Object.hasOwn(c,'warmup')),true);
});
test('unknown mission rejects the whole preparation before touching the first factory',async()=>{
  const calls=[];
  await assert.rejects(prepareSelectedMissions({tasks:[{mission:'intro',epoch:'e',revision:'r'},{mission:'not-known',epoch:'e',revision:'r'}],
    session:{},parameterDirectory:join(import.meta.dirname,'local-parameters'),pool:new MissionPool(),factories:{intro:async()=>{calls.push(1);}}}),/Unsupported/);
  assert.equal(calls.length,0);
});

test('the catalog registers a cached handler without a separate warming mode',async()=>{
  const calls=[],pool=new MissionPool(),session={};
  const task={mission:'wooden_hook',epoch:'e',revision:'r'};
  const options={tasks:[task],session,parameterDirectory:join(import.meta.dirname,'local-parameters'),pool,
    factories:{wooden_hook:async args=>{calls.push(args);return{preparation_mode:'on_demand',run:async()=>({result:'PASS_MISSION'}),cancel:async()=>{}};}}};
  const result=await prepareSelectedMissions(options);
  assert.equal(Object.hasOwn(result,'warmup_requested'),false);assert.equal(Object.hasOwn(calls[0],'warmup'),false);
  assert.equal((await prepareSelectedMissions(options)).prepared[0].prepared_now,false);
  assert.equal(calls.length,1);
});

test('public pipeline entry rejects missing live ownership and observation adapters',()=>{
  assert.throws(()=>executePreparedPipeline({pool:new MissionPool(),tasks:[],authorized:true}),/portable runtime/);
});
