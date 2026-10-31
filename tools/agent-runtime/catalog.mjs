// One stable executor entry point. Importing never connects to Unity or sends input.
import {isAbsolute,join} from 'node:path';
import {getMissionPool,runMissionSequence} from './mission-pool.mjs';
import {runMissionPipeline} from './pipeline.mjs';
const onboard=method=>async options=>(await import('./onboarding-runner.mjs'))[method](options);
export const PREPARERS=Object.freeze({intro:onboard('prepareIntroMission'),control:onboard('prepareControlMission'),
  wooden_hook:onboard('prepareWoodenHookMission'),hook_use:async options=>(await import('./hook-runner.mjs')).prepareHookMission(options),
  canned_eat:async options=>(await import('../../projects/ocean-nomad/tools/canned-eat/factory.mjs')).prepareCannedEatMission(options),
  shark_attack:onboard('prepareSharkAttackMission')});

export async function prepareSelectedMissions({tasks,session,parameterDirectory,pool=getMissionPool(),factories=PREPARERS}){
  if(!Array.isArray(tasks)||!tasks.length||!isAbsolute(parameterDirectory)||!session)throw Error('Explicit selected tasks, guarded session and local parameter directory required');
  for(const t of tasks){
    if(!PREPARERS[t.mission]||typeof factories[t.mission]!=='function'||!t.epoch||!t.revision)throw Error('Unsupported mission or missing fresh epoch/revision');
  }
  const prepared=[];
  for(const t of tasks){
    const result=await pool.prepare({...t,factory:()=>factories[t.mission]({session,parameterDirectory:join(parameterDirectory,t.mission)})});
    prepared.push({...pool.readiness(t),prepared_now:result.prepared_now});
  }
  return{status:'PREPARED_RUNTIME_HANDLERS',prepared};
}
export const executeSelectedMissions=options=>runMissionSequence(options.pool??getMissionPool(),options);
export const executePreparedPipeline=options=>{
  if(!['prepareTask','beforeRun','subscribe','guard','claim','finalize'].every(key=>typeof options?.[key]==='function')||!options.journal)
    throw Error('Use portable runtime.runPipeline with its ownership, observation and journal adapters');
  return runMissionPipeline({...options,pool:options.pool??getMissionPool()});
};
