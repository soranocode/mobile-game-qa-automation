import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createCycleArtifacts} from './cycle-journal.mjs';
import {readReviewedTasks} from '../portable/runtime.mjs';

async function directory(t){
  const parent=resolve(fileURLToPath(new URL('../../',import.meta.url)),'work/pipeline-artifact-tests');
  const folder=resolve(parent,randomUUID());await mkdir(folder,{recursive:true});
  t.after(async()=>{const child=relative(parent,folder);if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Unsafe fixture cleanup');await rm(folder,{recursive:true,force:true});});
  return folder;
}

test('the event stream, final report and proposed knowledge survive file persistence',async t=>{
  const folder=await directory(t),artifacts=await createCycleArtifacts({directory:folder,cycleId:'attempt-1'});
  artifacts.journal.record('mission_start',{mission:'intro'});
  artifacts.journal.record('mission_end',{mission:'intro',result:'PASS_MISSION'});
  await artifacts.journal.flush();
  const rows=(await readFile(resolve(artifacts.folder,'events.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r=>r.seq),[1,2]);
  await artifacts.save({result:'PASS_SEQUENCE'},{candidates:[{mission:'intro',status:'PROPOSED',knowledge_ids:['CARD']}]});
  const inbox=JSON.parse(await readFile(resolve(artifacts.folder,'knowledge-candidates.json'),'utf8'));
  assert.equal(inbox.active_knowledge_changed,false);assert.equal(inbox.status,'PROPOSED');
  assert.equal(inbox.candidates[0].mission,'intro');await artifacts.journal.close();
  await assert.rejects(createCycleArtifacts({directory:folder,cycleId:'attempt-1'}),/EEXIST/);
  await assert.rejects(createCycleArtifacts({directory:folder,cycleId:'../escape'}),/safe cycle ID/);
});

test('offline tickets validate owning cards and detect source changes before Unity is involved',async t=>{
  const folder=await directory(t),hash=value=>createHash('sha256').update(value).digest('hex');
  const card='source-derived rule',code='export const known = true;';
  const registry=JSON.stringify({missions:{intro:{source_ids:['CARD'],reviewed_sha256:{CARD:hash(card),'commands.mjs':hash(code)}}}});
  const index=JSON.stringify({records:[{id:'CARD',path:'card.md'}]});
  const files={
    'brain/agents/missions.json':registry,'projects/ocean-nomad/knowledge/index.json':index,
    'projects/ocean-nomad/knowledge/card.md':card,'commands.mjs':code,
    'brain-store/portable-runtime/packets.json':JSON.stringify({schema:'ocean-portable-packets/1',registry_sha256:hash(registry),index_sha256:hash(index),packets:{intro:{status:'PREPARED_KNOWLEDGE_ONLY',revision:'reviewed-revision'}}})
  };
  for(const [name,content] of Object.entries(files)){const path=resolve(folder,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content);}
  const tasks=await readReviewedTasks(['intro'],'current-epoch',folder);
  assert.equal(tasks[0].revision,'reviewed-revision');assert.deepEqual(tasks[0].knowledge_ids,['CARD']);
  await writeFile(resolve(folder,'commands.mjs'),'changed');
  await assert.rejects(readReviewedTasks(['intro'],'current-epoch',folder),/Reviewed source changed/);
});

test('a later artifact write failure cannot leave a saved PASS report',async t=>{
  const folder=await directory(t),artifacts=await createCycleArtifacts({directory:folder,cycleId:'failed-save',
    write:async(path,data,encoding)=>{if(path.endsWith('knowledge-candidates.json'))throw Error('disk full');return writeFile(path,data,encoding);}});
  await assert.rejects(artifacts.save({result:'PASS_SEQUENCE'},{candidates:[]}),/disk full/);
  await assert.rejects(readFile(resolve(artifacts.folder,'report.json')),/ENOENT/);
  await artifacts.journal.close();
});
