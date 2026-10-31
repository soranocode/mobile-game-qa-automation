// Offline lookahead overlaps the active mission. All Unity input stays under one lease.
import {CycleJournal} from './cycle-journal.mjs';
import {analyzeCycle} from './cycle-analysis.mjs';

const descriptor=t=>{
  if(!t||!['mission','epoch','revision'].every(k=>typeof t[k]==='string'&&t[k]))throw Error('Reviewed task descriptor required');
  return Object.freeze({mission:t.mission,epoch:t.epoch,revision:t.revision});
};
const same=(a,b)=>['mission','epoch','revision'].every(k=>a[k]===b[k]);
const aborted=()=>Error('Cycle stopped');
async function boundedPrepare(prepare,task,context,timeoutMs){
  let timer,listener;
  const stop=new Promise((_,reject)=>{
    listener=()=>reject(aborted());
    if(context.signal.aborted)listener();else context.signal.addEventListener('abort',listener,{once:true});
    timer=setTimeout(()=>reject(Error('Offline preparation timed out')),timeoutMs);
  });
  try{return await Promise.race([Promise.resolve().then(()=>{
    if(context.signal.aborted)throw aborted();return prepare(task,context);
  }),stop]);}
  finally{clearTimeout(timer);context.signal.removeEventListener('abort',listener);}
}

export function verifiedMissionResult(task,result){
  if(result?.mission!==task.mission)return false;
  if(result.result==='PASS_MISSION')return result.input_stopped===true&&
    result.done?.observed===true&&result.done.quest_uid===task.mission&&
    result.done.completion_fresh===true&&result.done.final_complete===true;
  return task.mission==='hook_use'&&result.result==='PASS_HOOK_USE'&&
    result.completion?.fresh===true&&result.completion.need>0&&result.completion.progress===result.completion.need&&
    result.cleanup?.input_stopped===true&&result.cleanup.blocked===false&&result.cleanup.new_errors===0;
}

export async function runMissionPipeline({pool,tasks,taskId,authorized,signal,
  prepareTask=async task=>({task}),beforeRun=async()=>{},subscribe,guard,claim,
  journal=new CycleJournal(),lookahead=2,prepareTimeoutMs=15000,finalize=async()=>{}}){
  if(authorized!==true||!taskId||!Array.isArray(tasks)||!tasks.length)throw Error('Fresh scoped cycle request required');
  if(!Number.isInteger(lookahead)||lookahead<1||lookahead>3||!Number.isFinite(prepareTimeoutMs)||prepareTimeoutMs<=0||prepareTimeoutMs>60000)throw Error('Bounded lookahead and preparation timeout required');
  if(typeof pool?.acquireCycle!=='function')throw Error('Restart the idle executor process after upgrading pipeline modules');
  const selected=Object.freeze(tasks.map(descriptor));
  const startedUtc=new Date().toISOString();
  const lease=pool.acquireCycle(taskId),pending=new Map(),planning=new Set(),results=[];
  let failure=null,closed=false,current=null,cancelPromise=null,unsubscribe,unguard,owner,cleanupConfirmed=true;
  const owned=fn=>owner?owner.run(fn):fn();
  const owners=new Map();
  const started=journal.now();
  const stop=error=>{
    if(error)failure??=error;
    cancelPromise??=pool.stop().catch(e=>{failure??=e;});
    return cancelPromise;
  };
  const onAbort=()=>{void stop();};
  const detachFailure=journal.onFailure(error=>{void stop(error);});
  signal?.addEventListener('abort',onAbort,{once:true});
  const emit=(type,fields={})=>journal.record(type,{cycle_id:taskId,...fields});
  const schedule=index=>{
    if(index>=selected.length||pending.has(index)||lease.signal.aborted||closed)return;
    const task=selected[index],began=journal.now(),slot={ready:false};
    emit('plan_start',{index,mission:task.mission});
    slot.promise=boundedPrepare(prepareTask,task,Object.freeze({index,signal:lease.signal}),prepareTimeoutMs)
      .then(ticket=>{
        if(closed||lease.signal.aborted)throw aborted();
        if(!same(descriptor(ticket?.task),task))throw Error('Prepared ticket changed the approved task or revision');
        const ids=ticket.knowledge_ids??[];
        if(!Array.isArray(ids)||ids.length>6||ids.some(id=>typeof id!=='string'||id.length>100))throw Error('Bounded owning knowledge IDs required');
        const frozen=Object.freeze({task,knowledge_ids:Object.freeze([...ids])});
        owners.set(task.mission,frozen.knowledge_ids);
        slot.ready=true;emit('plan_ready',{index,mission:task.mission,duration_ms:journal.now()-began});return frozen;
      }).catch(error=>{
        if(!lease.signal.aborted){emit('plan_failed',{index,mission:task.mission});void stop(error);}
        return{error};
      });
    pending.set(index,slot);planning.add(slot.promise);
    slot.promise.finally(()=>planning.delete(slot.promise));
  };
  emit('cycle_start',{missions:selected.map(t=>t.mission),lookahead,started_utc:startedUtc,source_versions:selected});
  try{
    if(signal?.aborted||journal.failure){await stop(journal.failure);throw aborted();}
    if(selected.some(task=>!pool.readiness(task).ready))throw Error('Warm all selected Unity commands before starting the pipeline');
    unguard=guard?.(()=>{if(lease.signal.aborted||journal.failure)throw aborted();});
    unsubscribe=subscribe?.(event=>{
      const {type,ms,...fields}=event;
      emit(type,{...fields,ms_tool:type==='mcp_end'?ms:undefined,index:current?.index,mission:current?.mission});
      if(type==='mcp_end'&&event.outcomes?.some(o=>o.blocked))void stop(Error('Unity error monitor blocked the cycle'));
      else if(type==='mcp_end'&&event.ok===false&&event.transport_attempted!==false)void stop(Error('MCP request failed; outcome requires review'));
    });
    owner=claim?.(lease.token);
    await owner?.begin();
    schedule(0);
    for(let index=0;index<selected.length;index++){
      if(lease.signal.aborted)break;
      schedule(index);const slot=pending.get(index),waiting=journal.now(),waited=!slot.ready;
      if(waited)emit('queue_wait',{index,mission:selected[index].mission});
      const ticket=await slot.promise;
      if(waited)emit('queue_ready',{index,mission:selected[index].mission,duration_ms:journal.now()-waiting});
      if(ticket.error)throw ticket.error;
      if(lease.signal.aborted||journal.failure)break;
      // Only this owner can perform fresh live validation, after previous cleanup.
      await owned(()=>beforeRun(ticket.task,{index,signal:lease.signal}));
      if(lease.signal.aborted||journal.failure)break;
      if(!pool.readiness(ticket.task).ready)throw Error('Prepared handler invalidated before admission');
      current={index,mission:ticket.task.mission};const began=journal.now();
      emit('mission_start',current);
      const missionScope=owner?.createMission?.();
      const running=pool.run({...ticket.task,taskId:taskId+'/'+index,authorized:true,lease:lease.token,runInScope:missionScope?.run??owned});
      for(let next=index+1;next<=index+lookahead;next++)schedule(next);
      let result;
      try{result=await running;}
      catch(error){
        results.push({mission:ticket.task.mission,result:'NEEDS_REVIEW',reason:String(error).slice(0,300),input_stopped:false});
        emit('mission_end',{...current,result:'NEEDS_REVIEW',duration_ms:journal.now()-began});
        if(!lease.signal.aborted)throw error;break;
      }finally{missionScope?.close();}
      if(!result||typeof result!=='object')result={mission:ticket.task.mission,result:'NEEDS_REVIEW',reason:'Missing mission result',input_stopped:false};
      result=structuredClone(result);
      results.push(result);
      emit('mission_end',{...current,result:result.result,duration_ms:journal.now()-began});
      if(lease.signal.aborted||journal.failure)break;
      if(!verifiedMissionResult(ticket.task,result))throw Error('Fresh mission success and input cleanup not confirmed');
      pending.delete(index);current=null;
    }
  }catch(error){if(!lease.signal.aborted||failure)failure??=error;}
  finally{
    closed=true;
    if(failure||lease.signal.aborted||journal.failure)await stop(journal.failure);
    // Abort leftover preparation before finalization; late answers can never be admitted.
    if(planning.size){lease.signal.aborted||await stop();await Promise.allSettled([...planning]);}
    if(cancelPromise)await cancelPromise;
    try{await owner?.finish();}catch(error){failure??=error;}
    try{owner?.release();}catch(error){failure??=error;cleanupConfirmed=false;}
    try{unsubscribe?.();}catch(error){failure??=error;}
    try{unguard?.();}catch(error){failure??=error;}
    detachFailure();signal?.removeEventListener('abort',onAbort);
    if(cleanupConfirmed)pool.releaseCycle(lease.token);
  }
  let result=failure||journal.failure?'NEEDS_REVIEW':lease.signal.aborted?'STOPPED':results.length===selected.length?'PASS_SEQUENCE':'NEEDS_REVIEW';
  const report={schema:'ocean-mission-cycle/1',cycle_id:taskId,started_utc:startedUtc,source_versions:selected,result,results,
    reason:failure?String(failure).slice(0,400):null,cleanup_confirmed:cleanupConfirmed,execution_ms:journal.now()-started};
  emit('cycle_execution_end',{result});
  try{await journal.close();}
  catch(error){report.result='NEEDS_REVIEW';report.reason='Cycle journal failed: '+String(error).slice(0,300);}
  const analysis=analyzeCycle(journal.events,results);
  for(const candidate of analysis.candidates)candidate.knowledge_ids=owners.get(candidate.mission)??[];
  try{report.evidence_path=await finalize({report,analysis,events:journal.events});}
  catch(error){report.result='NEEDS_REVIEW';report.reason='Cycle finalization failed: '+String(error).slice(0,300);}
  return{...report,analysis};
}
