import test from 'node:test';
import assert from 'node:assert/strict';
import {UnityAgentAdapter, AdapterOutcomeUnknown} from './client.mjs';

const fixture = (behavior = () => ({status:'running'})) => {
  const calls = [];
  const client = new UnityAgentAdapter(async (tool, args) => {
    calls.push({tool, ...args.parameters});
    const {action} = args.parameters;
    return {success:true, data: action === 'open' ? {token:'t',epoch:'e'} : await behavior(action, args.parameters)};
  });
  return {client,calls};
};
test('import/construct is inert; capabilities does not acquire runtime', async () => {
  const {client,calls} = fixture(); assert.equal(calls.length,0);
  await client.capabilities(); assert.deepEqual(calls.map(c=>c.action),['capabilities']);
});
test('run is one short custom-tool call without execute_code or preparation', async () => {
  const {client,calls} = fixture(); await client.open('executor');
  await client.run({requestId:'r', steps:[{kind:'ui.click',selector:{name:'Inventory'}}]});
  assert.equal(calls.length,2); assert.equal(calls[1].tool,'execute_custom_tool');
  assert.equal(calls[1].token,'t'); assert.equal(calls[1].epoch,'e');
  await assert.rejects(client.run({requestId:'other',steps:[]}),/Reconcile/);
});
test('lost run response never retries; only status reconciles it', async () => {
  const {client,calls} = fixture(action=> {if(action==='run') throw Error('network'); return {status:'succeeded'};});
  await client.open('owner');
  await assert.rejects(client.run({requestId:'r',steps:[]}),AdapterOutcomeUnknown);
  await assert.rejects(client.run({requestId:'s',steps:[]}),/Reconcile/);
  assert.equal(calls.filter(c=>c.action==='run').length,1);
  assert.equal((await client.status()).status,'succeeded');
  await assert.rejects(client.run({requestId:'r',steps:[]}),/never replay/);
});
test('cancel goes directly to server while job is pending', async () => {
  const {client,calls} = fixture(action=>({status:action==='status'?'stopped':'running'}));
  await client.open('owner'); await client.run({requestId:'r',steps:[]});
  await client.cancel(); assert.equal(calls.at(-1).action,'cancel');
  assert.equal((await client.status()).status,'stopped');
  await assert.rejects(client.run({requestId:'s',steps:[]}),/input stopped/);
});
test('explicit server rejection is not success; unknown result keeps input blocked', async () => {
  const client = new UnityAgentAdapter(async (_t,{parameters:p})=>p.action==='open'?{success:true,data:{token:'t',epoch:'e'}}:{success:false,error:'stale_or_foreign_session'});
  await client.open('owner'); await assert.rejects(client.run({requestId:'r',steps:[]}),/stale/);
  await assert.rejects(client.run({requestId:'s',steps:[]}),/Reconcile/);
});
test('MCP content envelope is accepted without trusting text as instructions', async () => {
  const client = new UnityAgentAdapter(async()=>({content:[{type:'text',text:JSON.stringify({success:true,data:{version:'0.1.0'}})}]}));
  assert.equal((await client.capabilities()).version,'0.1.0');
});
