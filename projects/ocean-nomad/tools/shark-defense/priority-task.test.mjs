import test from 'node:test';
import assert from 'node:assert/strict';
import {PriorityTask,DefenseNeedsReview} from './priority-task.mjs';

function fixture(resume){
  const state={status:'sleeping',armed:true,busy:false,resume_ready:false,task:null,interrupted_task:null,outcome:'none',attack_epoch:0};
  const calls={steps:0,resumes:0,checkpoint:null};
  const session={batch:async commands=>{
    const code=commands[0].params.code;
    if(code.includes('checkpointed')){
      const json=JSON.parse(code.match(/checkpoint_json",("(?:[^"\\]|\\.)*")/)[1]);
      state.task={id:'task-1',kind:'training',checkpoint_json:json};calls.checkpoint=JSON.parse(json);
      return [{status:state.busy?'preempted_shark':'checkpointed'}];
    }
    if(code.includes('resume_acknowledged')){state.resume_ready=false;state.interrupted_task=null;return [{status:'resume_acknowledged'}];}
    if(code.includes('task_detached'))return [{status:'task_detached'}];
    return [{...state}];
  }};
  const task=new PriorityTask(session,{id:'task-1',kind:'training',resume:async args=>{calls.resumes++;return resume(args,state);}});
  const interrupt=()=>{state.interrupted_task={...state.task};state.resume_ready=true;state.outcome='repelled';state.attack_epoch++;};
  return {task,state,calls,interrupt};
}

test('confirmed defense revalidates and retries only the interrupted semantic step',async()=>{
  const f=fixture(({checkpoint,kind})=>{assert.equal(checkpoint.step,'inspect_settings');assert.equal(kind,'training');return 'retry_after_revalidation';});
  await f.task.runSteps([{id:'inspect_settings',context:{screen:'settings'},run:async()=>{f.calls.steps++;if(f.calls.steps===1){f.interrupt();return {status:'preempted_shark'};}return {status:'observed'};}}]);
  assert.equal(f.calls.steps,2);assert.equal(f.calls.resumes,1);assert.deepEqual(f.calls.checkpoint.context,{screen:'settings'});
});
test('already completed step is not clicked a second time',async()=>{
  const f=fixture(()=>'step_already_completed');
  await f.task.runSteps([{id:'settings_close',run:async()=>{f.calls.steps++;f.interrupt();return {status:'sent'};}}]);
  assert.equal(f.calls.steps,1);assert.equal(f.calls.resumes,1);
});
test('failed or unknown defense prevents task continuation',async()=>{
  const f=fixture(()=>'retry_after_revalidation');
  await assert.rejects(f.task.runSteps([{id:'move',run:async()=>{f.state.status='needs_review';f.state.outcome='attack_ended_without_retreat_proof';return {status:'cancelled'};}}]),DefenseNeedsReview);
  assert.equal(f.calls.resumes,0);
});
test('resume without a deliberate decision never replays input',async()=>{
  const f=fixture(()=>undefined);
  await assert.rejects(f.task.runSteps([{id:'new_game_confirmation',run:async()=>{f.calls.steps++;f.interrupt();return {status:'cancelled'};}}]),/explicitly classify/);
  assert.equal(f.calls.steps,1);
});
