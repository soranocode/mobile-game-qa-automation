import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {validateConfig,readReviewedTasks,REPO} from './runtime.mjs';

const config={schema:'ocean-qa-local/1',gameProject:resolve(REPO,'work/test-game'),endpoint:'http://127.0.0.1:8080/mcp',artifactDirectory:'brain-store/portable-runtime'};
test('machine settings accept local Unity and keep artifacts in ignored storage',()=>{
  assert.equal(validateConfig(config).artifactDirectory,resolve(REPO,config.artifactDirectory));
});
test('runtime rejects remote endpoints and embedded credentials',()=>{
  for(const endpoint of ['https://example.com/mcp','http://user:password@127.0.0.1:8080/mcp','http://127.0.0.1:8080/mcp?token=example'])
    assert.throws(()=>validateConfig({...config,endpoint}),/local HTTP/);
});
test('runtime artifacts cannot overwrite the game or repository sources',()=>{
  for(const artifactDirectory of ['brain-store','../other','tools/runtime','brain-store/../../other'])
    assert.throws(()=>validateConfig({...config,artifactDirectory}),/ignored brain-store/);
});
test('unknown and duplicate tasks cannot become executable mission requests',async()=>{
  await assert.rejects(readReviewedTasks(['intro','intro'],'epoch'),/distinct/);
  await assert.rejects(readReviewedTasks(['not-known'],'epoch'));
});
