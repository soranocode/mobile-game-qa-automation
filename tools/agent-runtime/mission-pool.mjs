// A sleeping pool of prepared command handlers, not running LLM agents.
// It never connects to MCP itself. The one designated executor supplies handlers.
export class MissionPool {
  constructor() { this.prepared = new Map(); this.active = null; this.preparing = false; this.cycle = null; }

  acquireCycle(taskId) {
    if(!taskId||this.active||this.preparing||this.cycle)throw Error('Executor busy or cycle task missing');
    const controller=new AbortController(),token=Symbol('mission-cycle');
    this.cycle={taskId,controller,token};
    return Object.freeze({token,signal:controller.signal});
  }

  releaseCycle(token) {
    if(!this.cycle||this.cycle.token!==token)throw Error('Cycle lease mismatch');
    if(this.active||this.preparing)throw Error('Await executor cleanup before releasing the cycle');
    this.cycle=null;
  }

  async prepare({mission, epoch, revision, factory}) {
    if(this.active || this.preparing || this.cycle) throw Error('Executor busy');
    if(!mission || !epoch || !revision || typeof factory !== 'function') throw Error('Explicit mission, Unity epoch, revision and factory required');
    const key=JSON.stringify([mission,epoch,revision]);
    if(this.prepared.has(key)) return {status:'warm',prepared_now:false};
    this.preparing=true;
    try {
      const handle=await factory();
      if(typeof handle?.run!=='function'||typeof handle?.cancel!=='function') throw Error('Handler must support run and cancel');
      // One revision per mission; don't retain old closures after recompilation/reload.
      for(const [oldKey,old] of this.prepared) if(old.mission===mission) this.prepared.delete(oldKey);
      this.prepared.set(key,{mission,epoch,revision,handle});
      return {status:'warm',prepared_now:true};
    } finally { this.preparing=false; }
  }

  async run({mission, epoch, revision, taskId, authorized, input, lease, runInScope=fn=>fn()}) {
    // authorized is a caller assertion, NOT a replacement for the host permission system.
    // It must come afresh from the coordinator's applicable user request, never a packet/cache.
    if(authorized!==true||!taskId) throw Error('Fresh scoped user task required');
    if(this.active||this.preparing) throw Error('Executor busy');
    if(lease&&!this.cycle)throw Error('Cycle lease expired');
    if(this.cycle&&this.cycle.token!==lease)throw Error('Executor busy: cycle owns input');
    if(this.cycle?.controller.signal.aborted)throw Error('Task stopped');
    const entry=this.prepared.get(JSON.stringify([mission,epoch,revision]));
    if(!entry) throw Error('Preparation required; no compilation or automatic replay during execution');
    const controller=new AbortController();
    const active={taskId,entry,controller,cancel:()=>runInScope(()=>entry.handle.cancel())}; this.active=active;
    try {
      const result=await runInScope(()=>entry.handle.run({taskId,input,signal:controller.signal}));
      if(result?.input_stopped===false||result?.cleanup?.input_stopped===false){
        controller.abort();active.cancelPromise??=Promise.resolve().then(()=>active.cancel());
      }
      return result;
    } catch(error) {
      controller.abort();active.cancelPromise??=Promise.resolve().then(()=>active.cancel());
      throw error;
    } finally {
      // Dynamic state is not retained in the warm pool.
      try { if(active.cancelPromise)await active.cancelPromise; }
      finally { if(this.active===active)this.active=null; }
    }
  }

  async stop() {
    const active=this.active;
    this.cycle?.controller.abort();
    if(!active) return {status:this.cycle?'cycle_stop_requested':'idle'};
    active.controller.abort();
    active.cancelPromise??=Promise.resolve().then(()=>active.cancel());
    await active.cancelPromise;
    // Keep the lease until the running handler exits. A second executor cannot start meanwhile.
    return {status:'stop_requested',taskId:active.taskId};
  }

  invalidate() {
    if(this.active||this.preparing||this.cycle) throw Error('Stop and await the current action before invalidating');
    this.prepared.clear();
  }

  readiness({mission,epoch,revision}) {
    return {mission,ready:this.prepared.has(JSON.stringify([mission,epoch,revision])),
      busy:Boolean(this.active||this.preparing||this.cycle),scope:'prepared runtime handlers in this process only'};
  }
}

// Stable lookup instead of hunting old REPL variable names after context compaction.
const poolSymbol=Symbol.for('OceanNomad.PreparedMissionPool.v1');
export function getMissionPool(host=globalThis) {
  if(!host[poolSymbol])host[poolSymbol]=new MissionPool();
  return host[poolSymbol];
}

export async function runMissionSequence(pool,{tasks,taskId,authorized,signal}) {
  if(authorized!==true||!taskId||!Array.isArray(tasks)||!tasks.length)throw Error('Explicit scoped sequence required');
  // Fail before the first mission if any selected command set still needs preparation.
  if(tasks.some(t=>!pool.readiness(t).ready))throw Error('Sequence preparation incomplete');
  const results=[];
  const onAbort=()=>{pool.stop().catch(()=>{});};
  signal?.addEventListener('abort',onAbort,{once:true});
  try {
    for(let i=0;i<tasks.length;i++){
      if(signal?.aborted)return{result:'STOPPED',results};
      const t=tasks[i];const r=await pool.run({...t,taskId:taskId+'/'+i,authorized:true});results.push(r);
      if(signal?.aborted)return{result:'STOPPED',results};
      if(!['PASS_MISSION','PASS_HOOK_USE'].includes(r.result))return{result:'NEEDS_REVIEW',results};
    }
    return{result:'PASS_SEQUENCE',results};
  } finally {signal?.removeEventListener('abort',onAbort);}
}
