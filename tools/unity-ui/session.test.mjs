import test from 'node:test';
import assert from 'node:assert/strict';
import { FastUiSession } from './session.mjs';

const template = 'const string role = "__ROLE__"; __ERROR_WATCH_SETUP__ // fake engine for transport tests';

test('a stopped client cannot send input', async () => {
  let requests = 0;
  const session = new FastUiSession(async () => { requests++; }, template);
  await assert.rejects(session.step('confirm_new_game'), /Begin/);
  assert.equal(requests, 0);
});
test('unguarded legacy templates are rejected before an input command is built',()=>{
  const session=new FastUiSession(async()=>{},'const string role = "__ROLE__";');
  assert.throws(()=>session.body('open_settings'),/missing the error watcher guard/);
});

test('pending acknowledgment never repeats or selects another click; finish disables input', async () => {
  const inputs = [];
  let stopped = false;
  const invoke = async (name, args) => {
    if (name === 'execute_code') return { success: true, data: { result: { installed: true } } };
    assert.equal(name, 'batch_execute');
    const results = args.commands.map(command => {
      const code = command.params.code;
      let value;
      if (code.includes('status = "begun"')) value = { status: 'begun' };
      else if (code.includes('stopped = true')) { stopped = true; value = { stopped: true }; }
      else if (code.includes('disarmed = true')) value = { disarmed: true };
      else if (code.includes('role = "observe"')) value = { status: stopped ? 'stopped' : 'pending', controls: [] };
      else {
        inputs.push(code.match(/role = "([^"]+)"/)[1]);
        value = { status: 'pending' };
      }
      return { callSucceeded: true, result: { success: true, data: { result: value } } };
    });
    return { success: true, data: { results } };
  };
  const session = new FastUiSession(invoke, template);
  await session.begin();
  const response = await session.step('confirm_new_game', 0);
  assert.equal(response.input.status, 'pending');
  await session.observe();
  await session.observe();
  assert.deepEqual(inputs, ['confirm_new_game']);
  await session.finish();
  await assert.rejects(session.step('open_menu'), /Begin/);
  assert.deepEqual(inputs, ['confirm_new_game']);
});

test('a new error interrupts the step and locally latches further input', async () => {
  let requests = 0;
  let observed = 0;
  const session = new FastUiSession(async (name, args) => {
    if (name === 'execute_code') return { success: true, data: { result: { installed: true } } };
    requests++;
    return { success: true, data: { results: args.commands.map(c => {
      let value;
      if(c.params.code.includes('status = "begun"')) value={status:'begun'};
      else if(c.params.code.includes('role = "observe"')) value=++observed===1
        ? {status:'idle',error_watch:{available:true,blocked:false}}
        : {status:'blocked_new_error',error_watch:{available:true,blocked:true,unexpected_new_errors:1}};
      else value={status:'pending'};
      return {callSucceeded:true,result:{success:true,data:{result:value}}};
    })}};
  }, template);
  await session.begin();
  await assert.rejects(session.step('open_settings'),e=>e.code==='UNITY_NEW_ERROR');
  const before=requests;
  await assert.rejects(session.step('start_new_game'),e=>e.code==='UNITY_NEW_ERROR');
  assert.equal(requests,before);
});

test('cleanup restores state even when the error indicator is still red', async () => {
  const session = new FastUiSession(async (name,args)=>({success:true,data:{results:args.commands.map(c=>({
    callSucceeded:true,result:{success:true,data:{result:c.params.code.includes('stopped = true')
      ? {stopped:true,error_watch:{available:true,blocked:true,unexpected_new_errors:1}}
      : {disarmed:true}}}}))}}),template);
  session.active=true;
  const cleanup=await session.finish();
  assert.equal(cleanup.stopped,true);assert.equal(cleanup.error_watch.blocked,true);
  assert.equal(session.active,false);
});
