import {randomUUID} from 'node:crypto';
import {KEY,readDefense} from './install.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exec=code=>({tool:'execute_code',params:{action:'execute',code,safety_checks:true}});
export class DefenseNeedsReview extends Error {
  constructor(state){super(`Shark defense needs review: ${state.outcome??state.status}`);this.state=state;}
}

// A semantic step journal for active tests/training. Resume must re-observe the game;
// repeating an interrupted click is never the default. Coordinates are not a bookmark.
export class PriorityTask {
  constructor(session,{id=randomUUID(),kind,resume}){
    if(!['test','training'].includes(kind)||typeof resume!=='function')throw new Error('Task kind and a semantic resume callback are required');
    this.session=session;this.id=id;this.kind=kind;this.resume=resume;this.sequence=0;
  }
  async checkpoint(value){
    const json=JSON.stringify(value);if(json.length>4096)throw new Error('Checkpoint is too large');
    const code=`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d==null)return new{status="not_installed"};if((bool)d["busy"])return new{status="preempted_shark"};d["task"]=new System.Collections.Generic.Dictionary<string,object>{{"id",${JSON.stringify(this.id)}},{"kind",${JSON.stringify(this.kind)}},{"checkpoint_json",${JSON.stringify(json)}}};return new{status="checkpointed"};`;
    return (await this.session.batch([exec(code)],{checkErrors:false}))[0];
  }
  async ready(){
    const deadline=performance.now()+48000;let state;
    do{
      state=await readDefense(this.session);
      if(state.status==='needs_review'||state.status==='not_installed'||state.status==='stopped')throw new DefenseNeedsReview(state);
      if(!state.busy)break;
      await pause(250);
    }while(performance.now()<deadline);
    if(state.busy)throw new DefenseNeedsReview({...state,outcome:'host_wait_budget'});
    if(state.resume_ready&&state.interrupted_task?.id===this.id){
      const bookmark=JSON.parse(state.interrupted_task.checkpoint_json);
      const decision=await this.resume({checkpoint:bookmark,kind:this.kind,outcome:state.outcome,attackEpoch:state.attack_epoch});
      if(!['retry_after_revalidation','step_already_completed'].includes(decision))throw new Error('Resume must explicitly classify the interrupted semantic step');
      const code=`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d!=null&&!(bool)d["busy"]){d["resume_ready"]=false;d["interrupted_task"]=null;}return new{status="resume_acknowledged"};`;
      await this.session.batch([exec(code)],{checkErrors:false});
      return {resumed:true,decision};
    }
    return {resumed:false};
  }
  async runSteps(steps){
    const values=[];
    try{
      for(let index=0;index<steps.length;){
        await this.ready();
        const saved=await this.checkpoint({index,step:steps[index].id,stage:'before_action',context:steps[index].context??null});
        if(saved.status==='preempted_shark')continue;
        if(saved.status!=='checkpointed')throw new DefenseNeedsReview(saved);
        const value=await steps[index].run();
        const after=await this.ready();
        if(after.resumed&&after.decision==='retry_after_revalidation')continue;
        if(value?.status==='preempted_shark'&&!after.resumed)throw new Error('Input preempted without a confirmed resume');
        values.push(value);index++;
      }
      return values;
    }finally{
      // Do not erase the frozen interrupted bookmark on failed defense.
      const code=`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d!=null&&!(bool)d["busy"]){var t=d["task"] as System.Collections.Generic.Dictionary<string,object>;if(t!=null&&(string)t["id"]==${JSON.stringify(this.id)})d["task"]=null;}return new{status="task_detached"};`;
      await this.session.batch([exec(code)],{checkErrors:false});
    }
  }
}
