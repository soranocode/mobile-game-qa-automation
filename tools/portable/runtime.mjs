// Machine-local bootstrap only. Importing this file never connects, starts Play or sends input.
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {connectUnityMcp} from '../unity-ui/mcp-client.mjs';
import {FastUiSession} from '../unity-ui/session.mjs';
import {ERROR_WATCH_SNAPSHOT} from '../unity-ui/error-monitor.mjs';
import {getMissionPool} from '../agent-runtime/mission-pool.mjs';
import {prepareSelectedMissions} from '../agent-runtime/catalog.mjs';
import {executePreparedPipeline} from '../agent-runtime/catalog.mjs';
import {createCycleArtifacts} from '../agent-runtime/cycle-journal.mjs';
import {SettingsAdapter} from '../../projects/ocean-nomad/tools/fast-ui/settings-adapter.mjs';

export const REPO=fileURLToPath(new URL('../../',import.meta.url));
const KEY=Symbol.for('OceanNomad.PortableRuntime.v1');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const text=path=>readFile(resolve(REPO,path),'utf8');
export function validateConfig(config,repo=REPO){
  if(config?.schema!=='ocean-qa-local/1'||!isAbsolute(config.gameProject??''))throw Error('Initialize a local absolute gameProject first');
  const endpoint=new URL(config.endpoint);
  if(endpoint.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.pathname!=='/mcp'||endpoint.search||endpoint.hash)throw Error('Only local HTTP MCP is configured by this profile');
  const directory=resolve(repo,config.artifactDirectory),safeRoot=resolve(repo,'brain-store');
  const child=relative(safeRoot,directory);
  if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Runtime artifacts must stay below ignored brain-store/');
  return{...config,artifactDirectory:directory};
}
const LIVE=`${ERROR_WATCH_SNAPSHOT}var key="QaAgent.PreparedEpoch.v1";
var epoch=System.AppDomain.CurrentDomain.GetData(key) as string;
if(string.IsNullOrEmpty(epoch)){epoch=System.Guid.NewGuid().ToString("N");System.AppDomain.CurrentDomain.SetData(key,epoch);}
var scenes=new System.Collections.Generic.List<string>();
var handles=new System.Collections.Generic.List<int>();
for(int i=0;i<UnityEngine.SceneManagement.SceneManager.sceneCount;i++){var s=UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);if(s.isLoaded){scenes.Add(s.name);handles.Add(s.handle);}}
return new{epoch=epoch,playing=UnityEditor.EditorApplication.isPlaying,paused=UnityEditor.EditorApplication.isPaused,owner=UnityEditor.SessionState.GetBool("QaAgent.FastUi.active",false),cycle_active=UnityEditor.SessionState.GetBool("QaAgent.FastUi.cycle_active",false),error_watch=errorWatchSnapshot(),scenes=scenes,handles=handles};`;
export async function readReviewedTasks(missions,epoch,repo=REPO){
  if(!Array.isArray(missions)||!missions.length||new Set(missions).size!==missions.length)throw Error('Explicit distinct missions required');
  const root=resolve(repo),registryBytes=await readFile(resolve(root,'brain/agents/missions.json'));
  const indexBytes=await readFile(resolve(root,'projects/ocean-nomad/knowledge/index.json'));
  const saved=JSON.parse(await readFile(resolve(root,'brain-store/portable-runtime/packets.json'),'utf8'));
  if(saved.schema!=='ocean-portable-packets/1'||hash(registryBytes)!==saved.registry_sha256||hash(indexBytes)!==saved.index_sha256)throw Error('Refresh reviewed packets with bootstrap.py check');
  const registry=JSON.parse(registryBytes),index=JSON.parse(indexBytes);
  const cards=Object.fromEntries(index.records.map(r=>[r.id,r.path]));
  const tasks=[];
  for(const mission of missions){
    const definition=registry.missions[mission],packet=saved.packets[mission];
    if(!definition||!packet?.revision||packet.status!=='PREPARED_KNOWLEDGE_ONLY')throw Error('No reviewed mission packet: '+mission);
    for(const [key,wanted] of Object.entries(definition.reviewed_sha256)){
      const path=resolve(root,cards[key]?'projects/ocean-nomad/knowledge/'+cards[key]:key);
      const child=relative(root,path);
      if(child.startsWith('..')||isAbsolute(child)||hash(await readFile(path))!==wanted)throw Error('Reviewed source changed: '+key);
    }
    tasks.push({mission,epoch,revision:packet.revision,knowledge_ids:[...definition.source_ids]});
  }
  return tasks;
}
export async function openRuntime({configPath=resolve(REPO,'qa.local.json'),connect=connectUnityMcp}={}){
  const old=globalThis[KEY];
  if(old?.session.active||old?.cycleController||getMissionPool().active||getMissionPool().preparing||getMissionPool().cycle)throw Error('Current executor must finish before opening another runtime');
  const config=validateConfig(JSON.parse(await readFile(configPath,'utf8')));
  const client=await connect({projectRoot:config.gameProject,endpoint:config.endpoint});
  const session=new FastUiSession(client.invoke,await text('projects/ocean-nomad/tools/fast-ui/step.cs.txt'));
  const pool=getMissionPool();pool.invalidate();
  await mkdir(config.artifactDirectory,{recursive:true});
  const context=async()=>{
    const response=await session.invoke('execute_code',{action:'execute',code:LIVE,safety_checks:true});
    const state=response.data?.result;
    if(!state?.epoch||!Array.isArray(state.scenes)||state.owner||(state.cycle_active&&!session.cycleActive))throw Error('Fresh idle Unity context required; do not take another input owner');
    if(session.cycleActive)session.checkCycleSnapshot(state.error_watch);
    return{...state,key:JSON.stringify([state.epoch,state.handles])};
  };
  let preparedEpoch;
  let recovering;
  const preparedTasks=new Map();
  const runtime={config,client:Object.freeze({invoke:session.invoke,timings:client.timings}),session,pool,cycleController:null,
    async prepareMissions(missions){
      if(runtime.cycleController)throw Error('Warm Unity commands before the active pipeline');
      const state=await context();
      if(!state.playing||state.paused||!state.scenes.includes('Game'))throw Error('Prepare missions in the running unpaused Game scene');
      if(preparedEpoch&&preparedEpoch!==state.key){pool.invalidate();preparedTasks.clear();}
      const tasks=await readReviewedTasks(missions,state.key);
      const result=await prepareSelectedMissions({tasks,session,pool,parameterDirectory:config.artifactDirectory});
      if(preparedEpoch!==state.key)await session.prepareCyclePrimitives();
      for(const task of tasks)preparedTasks.set(task.mission,task);
      preparedEpoch=state.key;return result;
    },
    async runMissions(options){return runtime.runPipeline(options);},
    async runPipeline({missions,taskId,authorized,signal,lookahead=2}){
      if(authorized!==true||!taskId)throw Error('A fresh applicable human request is required');
      if(runtime.cycleController||pool.active||pool.cycle||pool.preparing)throw Error('Executor busy');
      if(!Array.isArray(missions)||!missions.length||new Set(missions).size!==missions.length)throw Error('Explicit distinct missions required');
      const tasks=missions.map(mission=>{
        const task=preparedTasks.get(mission);
        if(!task||task.epoch!==preparedEpoch||!pool.readiness(task).ready)throw Error('Warm requested mission first: '+mission);
        return task;
      });
      const controller=new AbortController();runtime.cycleController=controller;
      const cycleSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      try{
        const artifacts=await createCycleArtifacts({directory:config.artifactDirectory,cycleId:'cycle-'+randomUUID()});
        return await executePreparedPipeline({pool,tasks,taskId,authorized,signal:cycleSignal,lookahead,
          journal:artifacts.journal,
          // This preparer receives no session or transport. It reads only versioned files.
          prepareTask:async(task,{signal:preparationSignal})=>{
            const fresh=(await readReviewedTasks([task.mission],task.epoch))[0];
            if(preparationSignal.aborted)throw Error('Preparation stopped');
            return{task:fresh,knowledge_ids:fresh.knowledge_ids};
          },
          beforeRun:async task=>{
            const state=await context();
            if(!state.playing||state.paused||!state.scenes.includes('Game')||state.key!==task.epoch)throw Error('Unity context changed; cycle invalidated');
            const fresh=(await readReviewedTasks([task.mission],state.key))[0];
            if(fresh.revision!==task.revision)throw Error('Knowledge changed after parallel preparation');
          },
          subscribe:listener=>session.subscribe(listener),guard:check=>session.guard(check),claim:token=>session.claimCycle(token),
          finalize:({report,analysis})=>artifacts.save(report,analysis)
        });
      }finally{runtime.cycleController=null;}
    },
    async createSettingsAdapter(){
      return new SettingsAdapter(session,{parameterFile:resolve(config.artifactDirectory,'settings.params'),
        inputCode:await text('projects/ocean-nomad/tools/fast-ui/selected-control.cs.txt'),
        parameterCode:await text('tools/unity-ui/parameter-input.cs.txt'),
        snapshotCode:await text('projects/ocean-nomad/tools/fast-ui/settings-state.cs.txt')});
    },
    stop:()=>{runtime.cycleController?.abort();return pool.stop();},
    async recoverStoppedCycle(){
      if(recovering)return recovering;
      if(runtime.cycleController||pool.active||pool.preparing||!pool.cycle)throw Error('Wait for the stopped cycle before cleanup reconciliation');
      const token=pool.cycle.token;
      recovering=(async()=>{
        await pool.stop();
        const result=await session.recoverStoppedCycle();pool.releaseCycle(token);return result;
      })();
      try{return await recovering;}finally{recovering=null;}
    },
  };
  await context();globalThis[KEY]=runtime;return runtime;
}
export function getRuntime(){if(!globalThis[KEY])throw Error('Call openRuntime once in this process first');return globalThis[KEY];}
