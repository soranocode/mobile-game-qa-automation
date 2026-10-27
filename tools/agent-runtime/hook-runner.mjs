// Restore the existing approved hook executor once, then reuse its prepared commands.
// Importing this module performs no Unity, MCP or game calls.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHookBindings} from '../../projects/ocean-nomad/tools/fast-spatial/runtime-bindings.mjs';
import {AimHookAction} from '../../projects/ocean-nomad/tools/fast-spatial/aim-hook.mjs';
import {runHookTrial} from '../../projects/ocean-nomad/tools/fast-spatial/hook-trial.mjs';
import * as cycle from '../../projects/ocean-nomad/tools/fast-spatial/hook-cycle.mjs';
import * as queue from '../../projects/ocean-nomad/tools/fast-spatial/hook-queue.mjs';

export async function prepareHookMission({session,parameterDirectory}) {
  if(!isAbsolute(parameterDirectory)) throw Error('Local absolute parameter directory required');
  await mkdir(parameterDirectory,{recursive:true});
  const source=name=>readFile(fileURLToPath(new URL('../../projects/ocean-nomad/tools/fast-spatial/'+name,import.meta.url)),'utf8');
  const [questSource,selectedUiSource,observerSource,aimSource]=await Promise.all([
    source('quest-click-frame.cs.txt'),source('selected-control.cs.txt'),
    source('hook-observer.cs.txt'),source('aim-and-hook.cs.txt')]);
  const bindings=createHookBindings({session,questSource,selectedUiSource,observerSource,
    questParameterFile:join(parameterDirectory,'quest.params')});
  const aim=new AimHookAction(session,{source:aimSource,parameterFile:join(parameterDirectory,'aim.params')});
  const bind=`UnityEditor.SessionState.SetString("QaAgent.QuestUi.params",${JSON.stringify(join(parameterDirectory,'quest.params'))});UnityEditor.SessionState.SetString("QaAgent.AimHook.v1.params",${JSON.stringify(join(parameterDirectory,'aim.params'))});return new{bound=true,input_sent=false};`;
  const rebind=async()=>session.batch([{tool:'execute_code',params:{action:'execute',code:bind,safety_checks:true}}]);
  const evidenceDirectory=join(parameterDirectory,'evidence');
  const saveReport=async report=>{
    await mkdir(evidenceDirectory,{recursive:true});
    const path=join(evidenceDirectory,Date.now()+'-'+randomUUID()+'.json');
    await writeFile(path,JSON.stringify(report,null,2),'utf8');
    return path;
  };
  return prepareHookHandle({session,bindings,aim,trial:runHookTrial,cycle,queue,saveReport,rebind});
}

export function compactHookReport(report,evidencePath) {
  const done=report.final?.done,cleanup=report.session_finish;
  const fresh=done?.observed===true&&done?.completion_fresh===true&&done?.final_complete===true;
  const watch=cleanup?.error_watch;
  const noUnexpectedErrors=watch?.available===true&&watch?.blocked===false&&watch?.unexpected_new_errors===0;
  return {mission:'hook_use',result:report.status==='complete'&&fresh&&cleanup?.stopped===true&&noUnexpectedErrors?'PASS_HOOK_USE':'NEEDS_REVIEW',
    status:report.status??'unknown',completion:{fresh,progress:done?.progress_after??null,need:done?.need??null},
    timings_ms:{total:report.timings?.total_ms??null,from_first_click:report.timings?.first_click_to_end_ms??null},
    attempts:report.attempts?.length??0,stop_reason:report.error?String(report.error).slice(0,400):null,
    cleanup:{input_stopped:cleanup?.stopped===true,new_errors:cleanup?.error_watch?.new_errors??null,
      blocked:cleanup?.error_watch?.blocked??null},evidence_path:evidencePath??null};
}

// Separate dependency seam: offline tests use fake transport, never an Editor instance.
export async function prepareHookHandle({session,bindings,aim,trial,cycle,queue,saveReport=async()=>null,rebind=async()=>{}}) {
  if(session.active) throw Error('Single idle executor session required');
  await session.begin();
  try {
    await rebind();
    await bindings.prepare();
    await aim.prepare();
    await bindings.observe('read'); // Warm the exact read command, without game input.
    await aim.stop();              // Warm cancellation before the timed run.
  } finally {
    try { await bindings.observe('stop'); }
    finally { if(session.active) await session.finish(); }
  }
  let running=false,stopped=false;
  return {
    async run({signal}) {
      if(running||session.active) throw Error('Executor busy');
      if(signal.aborted) throw Error('Task stopped');
      running=true;stopped=false;
      const check=()=>{if(stopped||signal.aborted)throw Error('Task stopped');};
      const guarded=fn=>async(...args)=>{check();return fn(...args);};
      const report={trace:[],timings:{},attempts:[]};
      let result,failure;
      try {
        await session.begin();
        check();
        await rebind();
        await bindings.observe('prepare'); // Fresh quest subscriptions, not old completion/targets.
        result=await trial({report,mcpTrace:{},session,preparationStarted:performance.now(),
          questUi:guarded(bindings.questUi),observeQuestUi:guarded(bindings.observeQuestUi),
          observe:async mode=>{if(mode!=='stop')check();return bindings.observe(mode);},
          click:guarded(bindings.click),aim:{run:guarded(aim.run.bind(aim))},cycle,queue});
      } catch(error) { failure=error;
      } finally {
        try { report.observer_stop=await bindings.observe('stop'); }
        catch(error) { failure??=error; }
        try { if(session.active)report.session_finish=await session.finish(); }
        catch(error) { failure??=error; }
        running=false;
      }
      const full={...report,...result};
      if(failure){full.status='error';full.error=String(failure);}
      const evidence=await saveReport(full);
      if(failure)throw Error(String(failure).slice(0,400)+(evidence?' | evidence: '+evidence:''));
      return compactHookReport(full,evidence);
    },
    async cancel() {
      stopped=true;
      try { await aim.stop(); }
      finally {
        try { await bindings.observe('stop'); }
        finally { if(session.active)await session.finish(); }
      }
    },
  };
}
