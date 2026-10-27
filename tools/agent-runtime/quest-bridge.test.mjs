import test from 'node:test';
import assert from 'node:assert/strict';
import {observerMode} from './quest-bridge.mjs';

test('observer mode is expanded even when its placeholder first appears in a comment',()=>{
  const source='// __MODE__ is prepare/read/stop\nvar mode="__MODE__";';
  for(const mode of ['prepare','read','stop']){
    const code=observerMode(source,mode);
    assert.ok(code.includes('var mode="'+mode+'";'));
    assert.ok(!code.includes('__MODE__'));
  }
  assert.throws(()=>observerMode(source,'finish'),/Unsupported/);
});
