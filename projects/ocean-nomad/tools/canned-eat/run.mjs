const UID='canned_eat';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const complete=(d,instance)=>d?.observed===true&&d.quest_uid===UID&&d.completion_fresh===true&&
  d.final_complete===true&&d.quest_instance===instance&&
  d.steps?.some(s=>s.uid===UID&&s.need===1&&s.value===1&&s.complete===true);

export async function runCannedEat({taskId,authorized,quest,inventory,begin,cleanup,
  installGuard,signal,timeoutMs=45000,doneTimeoutMs=2000,now=()=>performance.now(),wait=sleep}) {
  if(!taskId||authorized!==true)throw Error('Fresh scoped human task required');
  if(![begin,cleanup,quest?.bind,quest?.beginWatch,quest?.watch,quest?.questState,
    quest?.clickQuestUi,quest?.cleanup,quest?.setCheck,inventory?.setCheck,
    inventory?.dismissKnownDialog,inventory?.consumeOne].every(value=>typeof value==='function'))throw Error('Mission adapters required');
  const start=now(),phases=[];
  let closed=false,owned=false,unguard,food,done,reason,cleanupState,instance,result='NEEDS_REVIEW';
  const check=()=>{if(closed||signal?.aborted||now()-start>timeoutMs)throw Error('Task stopped or timed out');};
  const phase=async(name,fn)=>{check();const t=now();try{return await fn();}finally{phases.push({name,ms:now()-t});}};
  const watch=async()=>{
    check();const state=await quest.watch();
    if(state?.status!=='observed'||state.error_watch?.available!==true||state.error_watch.armed!==true||state.error_watch.blocked)throw Error('Current quest observation unavailable or blocked');
    return state;
  };
  const click=async(role,target='')=>{check();return quest.clickQuestUi(role,target);};
  const launch=async()=>{
    let state=await quest.questState();
    if(!state.open)state=await click('open');
    for(let n=0;n<3&&state.panel!=='None'&&state.panel!=='Quests';n++)state=await click('back');
    if(!state.open)state=await click('open');
    if(state.panel!=='Quests')state=await click('menu','Quests');
    if(!state.open||state.panel!=='Quests'||state.target_uid!==UID||!Number.isInteger(state.target_page)||state.target_page<0)throw Error('Current quest target unavailable');
    for(let n=0;n<20&&state.page!==state.target_page;n++){
      const previous=state.page;
      state=await click(state.page<state.target_page?'page_next':'page_prev');
      if(Math.abs(state.page-previous)!==1)throw Error('Page transition not confirmed');
    }
    if(state.page!==state.target_page||!state.visible_labels?.includes(UID))throw Error('Current canned_eat label not visible');
    await click('quest',UID);
    const active=await watch();
    if(!active.active||active.done?.observed)throw Error('Fresh active quest not confirmed');
  };
  try {
    quest.setCheck(check);inventory.setCheck(check);unguard=installGuard?.(check);
    const admission=await phase('begin',begin);
    owned=admission?.owned===true;
    if(admission?.status!=='begun'||!owned)throw Error('Mission begin is pending or unconfirmed');
    await phase('context_and_observer',async()=>{await quest.bind();const observed=await quest.beginWatch();if(observed?.status!=='prepared')throw Error('Quest observer not installed');});
    let state=await watch();
    if(state.done?.observed)throw Error('Old Done observed before this input');
    if(!state.active)await phase('quest_launch',launch);
    state=await watch();instance=state.active_instance;
    if(!state.active||!Number.isInteger(instance)||instance===0)throw Error('Current quest instance not established');
    await phase('close_cheat_panel',async()=>{
      let ui=await quest.questState();for(let n=0;n<4&&ui.open;n++)ui=await click('back');
      if(ui.open)throw Error('Cheat panel remains open');
    });
    await phase('dialog',()=>inventory.dismissKnownDialog());
    state=await watch();
    if(!state.active||state.active_instance!==instance||state.done?.observed||!state.steps?.some(step=>step.uid===UID&&step.need===1&&step.value===0&&!step.complete))throw Error('Expected same current instance at 0/1 before Use');
    food=await phase('inventory_skill',()=>inventory.consumeOne({uid:'Canned'}));
    if(food?.uid!=='Canned'||food.uses_sent!==1||food.quantity_before-food.quantity_after!==1||food.closed!==true)throw Error('Single consumption not confirmed');
    done=await phase('fresh_done',async()=>{
      const deadline=now()+doneTimeoutMs;
      for(;;){
        const observed=await watch();
        if(complete(observed.done,instance))return observed.done;
        if(now()>=deadline)throw Error('Fresh matching Done absent; sent Use must not be repeated');
        check();await wait(30);check();
      }
    });
    result='PASS_MISSION';
  } catch(error) {reason=String(error).slice(0,500);}
  finally {
    closed=true;const t=now();
    try{if(owned)await quest.cleanup();}catch(error){result='NEEDS_REVIEW';reason??=String(error);}
    try{
      if(owned)cleanupState=await cleanup();
      if(cleanupState?.input_stopped!==true||cleanupState.blocked!==false||cleanupState.new_errors!==0){result='NEEDS_REVIEW';reason??='Input or watcher cleanup not confirmed';}
    }catch(error){result='NEEDS_REVIEW';reason??=String(error);}
    finally{unguard?.();}
    phases.push({name:'cleanup',ms:now()-t});
  }
  return{mission:UID,result,task_id:taskId,done,food,current_instance:instance,input_stopped:cleanupState?.input_stopped===true,cleanup:cleanupState,reason,
    timings:{execution_ms:now()-start,phases},source:'saved canned_eat composition; reusable packaging verified offline'};
}
