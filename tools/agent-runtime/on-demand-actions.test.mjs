import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AimHookAction} from '../../projects/ocean-nomad/tools/fast-spatial/aim-hook.mjs';
import {RaftRouteAction} from '../../projects/ocean-nomad/tools/raft-navigation/route-action.mjs';

test('aim and route construction send no Unity calls; first aim binds its own parameters',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'qa-first-use-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[],session={active:true,instrument:x=>x,batch:async commands=>{
    calls.push(commands);return[{parameters_set:true,input_sent:false},{status:'not_sent_covered'}];
  }};
  const file=join(dir,'aim.params');
  const aim=new AimHookAction(session,{source:'aim-input',parameterFile:file});
  const route=new RaftRouteAction(session,{source:'route-input',parameterFile:join(dir,'route.params')});
  assert.equal(calls.length,0);
  assert.equal(typeof aim.prepare,'undefined');assert.equal(typeof route.prepare,'undefined');
  assert.equal((await aim.run(42,{aimOnly:true})).status,'not_sent_covered');
  assert.equal(calls.length,1);assert.equal(await readFile(file,'utf8'),'aim\n42\ndirect\n');
  assert.ok(calls[0][0].params.code.includes('SetString("QaAgent.AimHook.v1.params",'));
  assert.equal(calls[0][1].params.code,'aim-input');
});
