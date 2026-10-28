import test from 'node:test';
import assert from 'node:assert/strict';
import {isAbsolute,join} from 'node:path';
import {prepareSelectedMissions,executePreparedPipeline} from './catalog.mjs';
import {MissionPool} from './mission-pool.mjs';

test('selected missions prepare once each on the same executor and distinct parameter files',async()=>{
  const pool=new MissionPool(),calls=[],session={guarded:true};
  const tasks=['intro','control','wooden_hook','hook_use','shark_attack'].map(mission=>({mission,epoch:'current-domain',revision:'reviewed-'+mission}));
  const factories=Object.fromEntries(tasks.map(t=>[t.mission,async args=>{calls.push({mission:t.mission,...args});return{run:async()=>({result:'PASS_MISSION'}),cancel:async()=>{}};}]));
  const directory=join(import.meta.dirname,'local-parameters');
  const options={tasks,session,parameterDirectory:directory,pool,factories};
  assert.equal((await prepareSelectedMissions(options)).prepared.every(t=>t.ready),true);
  assert.equal((await prepareSelectedMissions(options)).prepared.every(t=>!t.prepared_now),true);
  assert.equal(calls.length,5);assert.equal(calls.every(c=>c.session===session&&isAbsolute(c.parameterDirectory)),true);
  assert.equal(new Set(calls.map(c=>c.parameterDirectory)).size,5);
});
test('unknown mission rejects the whole preparation before touching the first factory',async()=>{
  const calls=[];
  await assert.rejects(prepareSelectedMissions({tasks:[{mission:'intro',epoch:'e',revision:'r'},{mission:'not-known',epoch:'e',revision:'r'}],
    session:{},parameterDirectory:join(import.meta.dirname,'local-parameters'),pool:new MissionPool(),factories:{intro:async()=>{calls.push(1);}}}),/Unsupported/);
  assert.equal(calls.length,0);
});

test('public pipeline entry rejects missing live ownership and observation adapters',()=>{
  assert.throws(()=>executePreparedPipeline({pool:new MissionPool(),tasks:[],authorized:true}),/portable runtime/);
});
