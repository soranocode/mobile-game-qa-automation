import test from 'node:test';
import assert from 'node:assert/strict';
import {observerMode,createQuestBridge} from './quest-bridge.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('observer mode is expanded even when its placeholder first appears in a comment',()=>{
  const source='// __MODE__ is prepare/read/stop\nvar mode="__MODE__";';
  for(const mode of ['prepare','read','stop']){
    const code=observerMode(source,mode);
    assert.ok(code.includes('var mode="'+mode+'";'));
    assert.ok(!code.includes('__MODE__'));
  }
  assert.throws(()=>observerMode(source,'finish'),/Unsupported/);
});

test('shark dependencies initialize on actual use under the normal error and stop guards',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ocean-defense-init-')),calls=[];
  try{
    const session={instrument:source=>source,errors:{async install(){}},async batch(commands,options){
      calls.push({commands,options});
      return commands.map(({params:{code}})=>{
        if(/status\s*=\s*"warmed"/.test(code))return{status:'warmed',name:code.match(/name\s*=\s*"([^"]+)"/)?.[1]};
        if(/status\s*=\s*"installed_disarmed"/.test(code))return{status:'installed_disarmed'};
        return{status:'sleeping',busy:false,armed:false};
      });
    }};
    const bridge=await createQuestBridge({mission:'shark_attack',session,parameterDirectory:directory});
    assert.equal(calls.length,0);assert.equal(bridge.prepare,undefined);
    await bridge.resetDefense();
    const initialization=calls.filter(v=>v.commands.some(c=>/SharkWarm\.|installed_disarmed/.test(c.params.code)));
    assert.equal(initialization.length,8);
    assert.equal(initialization.every(v=>v.options.checkErrors===true&&v.options.checkGuard===true),true);
    assert.equal(calls.some(v=>v.commands.some(c=>c.params.code.includes('require_melee'))),true);
  }finally{await rm(directory,{recursive:true,force:true});}
});
