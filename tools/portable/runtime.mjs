// Machine-local bootstrap only. Importing this file never connects, starts Play or sends input.
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {connectUnityMcp} from '../unity-ui/mcp-client.mjs';
import {FastUiSession} from '../unity-ui/session.mjs';
import {getMissionPool} from '../agent-runtime/mission-pool.mjs';
import {prepareSelectedMissions,executeSelectedMissions} from '../agent-runtime/catalog.mjs';
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
const LIVE=`var key="QaAgent.PreparedEpoch.v1";
var epoch=System.AppDomain.CurrentDomain.GetData(key) as string;
if(string.IsNullOrEmpty(epoch)){epoch=System.Guid.NewGuid().ToString("N");System.AppDomain.CurrentDomain.SetData(key,epoch);}
var scenes=new System.Collections.Generic.List<string>();
var handles=new System.Collections.Generic.List<int>();
for(int i=0;i<UnityEngine.SceneManagement.SceneManager.sceneCount;i++){var s=UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);if(s.isLoaded){scenes.Add(s.name);handles.Add(s.handle);}}
return new{epoch=epoch,playing=UnityEditor.EditorApplication.isPlaying,paused=UnityEditor.EditorApplication.isPaused,owner=UnityEditor.SessionState.GetBool("QaAgent.FastUi.active",false),scenes=scenes,handles=handles};`;
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
    tasks.push({mission,epoch,revision:packet.revision});
  }
  return tasks;
}
export async function openRuntime({configPath=resolve(REPO,'qa.local.json'),connect=connectUnityMcp}={}){
  const old=globalThis[KEY];
  if(old?.session.active||getMissionPool().active||getMissionPool().preparing)throw Error('Current executor must finish before opening another runtime');
  const config=validateConfig(JSON.parse(await readFile(configPath,'utf8')));
  const client=await connect({projectRoot:config.gameProject,endpoint:config.endpoint});
  const session=new FastUiSession(client.invoke,await text('projects/ocean-nomad/tools/fast-ui/step.cs.txt'));
  const pool=getMissionPool();pool.invalidate();
  await mkdir(config.artifactDirectory,{recursive:true});
  const context=async()=>{
    const response=await client.invoke('execute_code',{action:'execute',code:LIVE,safety_checks:true});
    const state=response.data?.result;
    if(!state?.epoch||!Array.isArray(state.scenes)||state.owner)throw Error('Fresh idle Unity context required; do not take another input owner');
    return{...state,key:JSON.stringify([state.epoch,state.handles])};
  };
  let preparedEpoch;
  const runtime={config,client,session,pool,
    async prepareMissions(missions){
      const state=await context();
      if(!state.playing||state.paused||!state.scenes.includes('Game'))throw Error('Prepare missions in the running unpaused Game scene');
      if(preparedEpoch&&preparedEpoch!==state.key)pool.invalidate();
      const tasks=await readReviewedTasks(missions,state.key);
      const result=await prepareSelectedMissions({tasks,session,pool,parameterDirectory:config.artifactDirectory});
      preparedEpoch=state.key;return result;
    },
    async runMissions({missions,taskId,authorized,signal}){
      if(authorized!==true||!taskId)throw Error('A fresh applicable human request is required');
      const state=await context();
      if(!state.playing||state.paused||!state.scenes.includes('Game')||state.key!==preparedEpoch)throw Error('Unity context changed; prepare again before a new authorized run');
      return executeSelectedMissions({pool,tasks:await readReviewedTasks(missions,state.key),taskId,authorized,signal});
    },
    async createSettingsAdapter(){
      return new SettingsAdapter(session,{parameterFile:resolve(config.artifactDirectory,'settings.params'),
        inputCode:await text('projects/ocean-nomad/tools/fast-ui/selected-control.cs.txt'),
        parameterCode:await text('tools/unity-ui/parameter-input.cs.txt'),
        snapshotCode:await text('projects/ocean-nomad/tools/fast-ui/settings-state.cs.txt')});
    },
    stop:()=>pool.stop(),
  };
  await context();globalThis[KEY]=runtime;return runtime;
}
export function getRuntime(){if(!globalThis[KEY])throw Error('Call openRuntime once in this process first');return globalThis[KEY];}
