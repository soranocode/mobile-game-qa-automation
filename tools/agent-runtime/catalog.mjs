// One stable executor entry point. Importing never connects to Unity or sends input.
import {isAbsolute,join} from 'node:path';
import {getMissionPool,runMissionSequence} from './mission-pool.mjs';
const onboard=method=>async options=>(await import('./onboarding-runner.mjs'))[method](options);
export const PREPARERS=Object.freeze({intro:onboard('prepareIntroMission'),control:onboard('prepareControlMission'),
  wooden_hook:onboard('prepareWoodenHookMission'),hook_use:async options=>(await import('./hook-runner.mjs')).prepareHookMission(options),
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
