// Offline orchestration tests only; no Unity import or connection.
import assert from 'node:assert/strict';
import {createInventoryActions} from './inventory-actions.mjs';
const HUD='CanvasController/PlayerScreen/SafeArea/UIHudInterfaceButtonsPanel/UIHudInterfaceBackpack';
const CLOSE='CanvasInterface/Backpack/SafeArea/RootNavigationWidget/CloseButton';
const USE='CanvasInterface/Backpack/Container/Main/InventoryExtendable/ActionWithItemsButtons/UseButton';
const CONTINUE='CanvasController/DialogWindow/Content/Buttons/DialogChoiceButton(Clone)';
function fake({quantity=9,delta=1,dialog=0,longUnlock=false}={}) {
  const state={open:false,selected:false,quantity,uses:0,pending:0,dialog,hudProbes:0,clicks:[],evidence:[]};
  const control=(id,path,blocked=false)=>({id,path,blocked});
  const motor={
    async click(id){
      state.clicks.push(id);
      if(id===10)state.open=true;
      else if(id===20)state.open=false;
      else if(id===30)state.selected=true;
      else if(id===40){state.uses++;state.pending=2;}
      else if(id===50)state.dialog--;
      else throw Error('Unexpected test click');
      return {status:'sent'};
    },
    async snapshot(name){
      if(state.pending&&!--state.pending)state.quantity-=delta;
      if(name)state.evidence.push(name);
      const cells=state.open?[
        {id:30,storage:'Backpack',index:3,uid:state.quantity?'Canned':null,q:state.quantity,dur:0,selected:state.selected&&state.quantity>0},
        {id:31,storage:'Belt',index:0,uid:'Rifle',q:1,dur:59,selected:false}
      ]:[];
      const controls=state.open?[control(20,CLOSE),control(40,USE)]:[control(10,HUD)];
      const texts=[];
      if(state.dialog){controls.push(control(50,CONTINUE));texts.push({path:'CanvasController/DialogWindow/Line',text:'Line '+state.dialog});}
      return {cells,controls,texts};
    },
    async invoke(phase){
      if(phase==='consume_guard')return {status:'ready',useInLongUnlock:longUnlock};
      if(phase==='inventory_actions_hud_ready')return {status:++state.hudProbes<3?'covered':'ready'};
      throw Error('Unexpected test invocation');
    }
  };
  return {state,motor};
}
export async function runInventoryActionsFakeTests() {
  const results=[];
  {
    const {state,motor}=fake();let checks=0;
    const actions=createInventoryActions({motor,guardCode:'fake guard'});
    actions.setCheck(()=>{checks++;});
    const result=await actions.consumeOne({uid:'Canned'});
    assert.deepEqual(result,{uid:'Canned',quantity_before:9,quantity_after:8,uses_sent:1,closed:true});
    assert.equal(state.uses,1);assert.equal(state.open,false);assert.ok(checks>10);
    assert.ok(state.evidence.some(n=>n.endsWith('-before')));assert.ok(state.evidence.some(n=>n.endsWith('-after')));
    results.push('delayed quantity: one Use, before/after evidence, HUD closed');
  }
  {
    const {state,motor}=fake({delta:2});
    const actions=createInventoryActions({motor,guardCode:'fake guard'});
    await assert.rejects(actions.consumeOne({uid:'Canned'}),/Unexpected selected-stack delta/);
    assert.equal(state.uses,1);assert.equal(state.clicks.filter(x=>x===40).length,1);
    results.push('unexpected delta: throws without replay');
  }
  {
    const {state,motor}=fake({dialog:2});
    const actions=createInventoryActions({motor,guardCode:'fake guard'});
    assert.deepEqual(await actions.dismissKnownDialog(),{closed:true});
    assert.equal(state.clicks.filter(x=>x===50).length,2);assert.equal(state.uses,0);assert.equal(state.dialog,0);
    assert.ok(state.hudProbes>=3);
    results.push('known dialog lines and bounded fade: HUD readiness, no consumption');
  }
  {
    const {state,motor}=fake({longUnlock:true});
    const actions=createInventoryActions({motor,guardCode:'fake guard'});
    await assert.rejects(actions.consumeOne({uid:'Canned'}),/LongUnlock active/);
    assert.equal(state.uses,0);
    results.push('LongUnlock guard: zero Use');
  }
  {
    const {state,motor}=fake({quantity:1});
    const actions=createInventoryActions({motor,guardCode:'fake guard'});
    const result=await actions.consumeOne({uid:'Canned'});
    assert.equal(result.quantity_after,0);assert.equal(state.uses,1);
    results.push('last Canned: empty cell and total-key removal');
  }
  return {passed:results.length,results,unity_calls:0};
}

import test from "node:test";
test("shared inventory actions: five fake-transport safety scenarios",async()=>{const r=await runInventoryActionsFakeTests();assert.equal(r.passed,5);assert.equal(r.unity_calls,0);});
