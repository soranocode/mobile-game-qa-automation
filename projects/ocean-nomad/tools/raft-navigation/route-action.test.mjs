import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RaftRouteAction,validateRoute} from './route-action.mjs';
const route={status:'PLANNED_NOT_EXECUTED',scene_handle:1,deck_y:0,
  geometry_sha256:'a'.repeat(64),points_xz:[[0,0],[.2,0]],
  safe_rectangles:[[-.5,-.5,.5,.5]],floor_ids:[42],floor_bounds:[[42,-.75,-.05,-.75,.75,0,.75]]};

test('invalid/unbounded geometry is refused before input',()=>{
  assert.throws(()=>validateRoute(route,{seconds:46}));
  assert.throws(()=>validateRoute({...route,status:'goal_outside_region'}));
  assert.throws(()=>validateRoute({...route,points_xz:[[0,0],[NaN,0]]}));
  assert.throws(()=>validateRoute({...route,floor_ids:[42,42]}));
});

async function fixture(t,scenario){
  const dir=await mkdtemp(join(tmpdir(),'raft-route-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const state={launches:0,reads:0,stops:0,request:null};
  const session={active:true,instrument:x=>x,batch:async commands=>{
    if(commands.length===2){state.launches++;state.request=JSON.parse(commands[0].params.code.match(/\.request",("[^"]+")/)[1]);
      return [{input_sent:false},scenario==='reject'?{status:'geometry_changed'}:{status:'running',request:state.request}];}
    if(commands[0].params.code.includes('["cancel"]')){state.stops++;return [{status:'cancelled',released:true}];}
    state.reads++;
    if(scenario==='error')throw new Error('new_unity_error');
    return [{status:'completed',released:true,request:scenario==='stale'?'previous-run':state.request}];
  }};
  return {action:new RaftRouteAction(session,{source:'__ERROR_WATCH_SETUP__',parameterFile:join(dir,'params')}),state};
}

test('rejected start never consumes an old completed result',async t=>{
  const {action,state}=await fixture(t,'reject');const result=await action.run(route);
  assert.equal(result.status,'geometry_changed');assert.equal(result.input_sent,false);
  assert.equal(state.reads,0);assert.equal(state.launches,1);
});
test('stale completion cancels this job instead of reporting success',async t=>{
  const {action,state}=await fixture(t,'stale');await assert.rejects(action.run(route),/Stale route result/);
  assert.equal(state.stops,1);assert.equal(state.launches,1);
});
test('new error triggers cleanup and never replays input',async t=>{
  const {action,state}=await fixture(t,'error');await assert.rejects(action.run(route),/new_unity_error/);
  assert.equal(state.stops,1);assert.equal(state.launches,1);
});
test('fresh completion is tied to this request',async t=>{
  const {action,state}=await fixture(t,'complete');const result=await action.run(route);
  assert.equal(result.status,'completed');assert.equal(result.request,state.request);assert.equal(state.launches,1);
});
