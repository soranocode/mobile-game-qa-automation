import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsAdapter } from './settings-adapter.mjs';
test('changing UI parameters reuses exactly the same C# commands',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qa-settings-'));
  try {
    const file=join(dir,'input.params'),inputs=[],payloads=[];
    let calls=0,snapshots=0;
    const session={active:false,instrument:s=>s.replace('__ERROR_WATCH_SETUP__','// guard'),
      async batch(commands) {
        calls++;
        const values=[];
        for(const c of commands){const code=c.params.code;
          if(code.includes('parameter_file'))values.push({bound:true,input_sent:false});
          else if(code.includes('input-marker')){inputs.push(code);payloads.push(await readFile(file,'utf8'));values.push({status:'pending'});}
          else if(code.includes('parameter-marker'))values.push({status:'selected'});
          else {snapshots++;values.push({status:'sent',ready:snapshots%3===0});}
        }
        return values;
      }};
    const adapter=new SettingsAdapter(session,{parameterFile:file,inputCode:'__ERROR_WATCH_SETUP__ input-marker',
      parameterCode:'__ERROR_WATCH_SETUP__ parameter-marker',snapshotCode:'__ERROR_WATCH_SETUP__ snapshot-marker'});
    assert.deepEqual(await adapter.prepare(),{registered:true,input_sent:false});
    assert.equal(calls,0,'local registration must not contact Unity');session.active=true;
    await adapter.click('sensitivity',{fraction:0.2,expect:s=>s.ready});
    await adapter.click('sensitivity',{fraction:0.8,expect:s=>s.ready});
    assert.equal(inputs.length,2);assert.equal(new Set(inputs).size,1);
    assert.notEqual(payloads[0],payloads[1]);
    await assert.rejects(adapter.click('unapproved_control'),/Unapproved/);
  } finally {await rm(join(dir,'input.params'),{force:true});await rmdir(dir);}
});

test('the first settings action works without a preliminary registration call',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qa-settings-first-'));
  try{
    const calls=[],session={active:true,instrument:x=>x,async batch(commands){
      calls.push(commands);
      return commands.map(c=>c.params.code.includes('parameter_file')?{bound:true}:
        c.params.code==='parameters'?{status:'selected'}:
        c.params.code==='input'?{status:'pending'}:{status:'sent',ready:true});
    }};
    const adapter=new SettingsAdapter(session,{parameterFile:join(dir,'input.params'),
      inputCode:'input',parameterCode:'parameters',snapshotCode:'snapshot'});
    assert.equal(calls.length,0);
    assert.equal((await adapter.click('music',{expect:s=>s.ready})).ready,true);
    assert.equal(calls.length,2);
    assert.equal(calls.flat().some(c=>c.params.code.includes('compiled_only')),false);
    assert.ok((await readFile(join(dir,'input.params'),'utf8')).includes('/Music/UISettingsSwitch'));
  }finally{await rm(join(dir,'input.params'),{force:true});await rmdir(dir);}
});
