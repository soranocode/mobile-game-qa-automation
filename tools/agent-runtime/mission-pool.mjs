// A sleeping pool of prepared command handlers, not running LLM agents.
// It never connects to MCP itself. The one designated executor supplies handlers.
export class MissionPool {
  constructor() { this.prepared = new Map(); this.active = null; this.preparing = false; }

  async prepare({mission, epoch, revision, factory}) {
    if(this.active || this.preparing) throw Error('Executor busy');
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

  async run({mission, epoch, revision, taskId, authorized, input}) {
    // authorized is a caller assertion, NOT a replacement for the host permission system.
    // It must come afresh from the coordinator's applicable user request, never a packet/cache.
    if(authorized!==true||!taskId) throw Error('Fresh scoped user task required');
    if(this.active||this.preparing) throw Error('Executor busy');
    const entry=this.prepared.get(JSON.stringify([mission,epoch,revision]));
    if(!entry) throw Error('Preparation required; no compilation or automatic replay during execution');
    const controller=new AbortController();
    const active={taskId,entry,controller}; this.active=active;
    try {
      return await entry.handle.run({taskId,input,signal:controller.signal});
    } finally {
      // Dynamic state is not retained in the warm pool.
      if(this.active===active) this.active=null;
    }
  }

  async stop() {
    const active=this.active;
    if(!active) return {status:'idle'};
    active.controller.abort();
    await active.entry.handle.cancel();
    // Keep the lease until the running handler exits. A second executor cannot start meanwhile.
    return {status:'stop_requested',taskId:active.taskId};
  }

  invalidate() {
    if(this.active||this.preparing) throw Error('Stop and await the current action before invalidating');
    this.prepared.clear();
  }

  readiness({mission,epoch,revision}) {
    return {mission,ready:this.prepared.has(JSON.stringify([mission,epoch,revision])),
      busy:Boolean(this.active||this.preparing),scope:'prepared runtime handlers in this process only'};
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
