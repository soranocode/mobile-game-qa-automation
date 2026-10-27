import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const exec=code=>({tool:'execute_code',params:{action:'execute',code,safety_checks:true}});
export const KEY='QaAgent.SharkDefense.v1';
export const READ=`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;return d==null?(object)new{status="not_installed"}:((System.Func<object>)d["read"])();`;
const register=(name,body,signature='System.Func<object>',arg='')=>`${signature} job=${arg}()=>{${body}};System.AppDomain.CurrentDomain.SetData("QaAgent.SharkWarm.${name}",job);return new{status="warmed",name=${JSON.stringify(name)},input_sent=false};`;
// Explicit lambdas, not reflection invocation of private game methods. Only UI controllers
// are executable; warm registration never calls a job or supplies world coordinates.
export async function prepareDefense(session){
  const existing=await readDefense(session);
  if(existing.busy)throw new Error('Defense is running; stop or await it before changing warm jobs');
  if(existing.armed)await setArmed(session,false);
  await session.errors.install();
  const load=name=>readFile(resolve(here,name),'utf8');
  const warm=[];
  let source=await load('../raft-navigation/route-driver.cs.txt');
  source=source.replaceAll('QaAgent.RaftRoute.v1','QaAgent.SharkRoute.v1')
    .replace('var lines=System.IO.File.ReadAllLines(UnityEditor.SessionState.GetString(key+".params",""));','var lines=(string[])System.AppDomain.CurrentDomain.GetData("QaAgent.SharkRoute.protocol");');
  warm.push(register('route',session.instrument(source)));
  source=await load('../fast-spatial/aim-enemy.cs.txt');
  warm.push(register('aim',session.instrument(source.replaceAll('QaAgent.AimEnemy.v1','QaAgent.SharkAim.v1'))));
  source=await load('../fast-spatial/input-motor.cs.txt');
  warm.push(register('motor',session.instrument(source.replaceAll('QaAgent.InputMotor.v1','QaAgent.SharkMotor.v1'))));
  warm.push(register('close',session.instrument(await load('close-ui.cs.txt'))));
  source=await load('../fast-spatial/quest-click-frame.cs.txt');
  source=source.replace('var lines=System.IO.File.ReadAllLines(UnityEditor.SessionState.GetString(p+"params",""));','var lines=new[]{"back",""};')
    .replaceAll('QaAgent.QuestUi.','QaAgent.SharkCheat.')
    .replace('const string p=', 'var defenseCloseGeneration=UnityEditor.SessionState.GetInt("QaAgent.SharkCheat.generation",0);const string p=')
    .replace('if(!UnityEditor.EditorApplication.isPlaying||', 'if(defenseCloseGeneration!=UnityEditor.SessionState.GetInt("QaAgent.SharkCheat.generation",0)||!UnityEditor.EditorApplication.isPlaying||');
  warm.push(register('back',session.instrument(source)));
  const planner=await load('plan.cs.txt');
  warm.push(`System.Func<object[],object[]> job=args=>{${planner}};System.AppDomain.CurrentDomain.SetData("QaAgent.SharkWarm.plan",job);return new{status="warmed",name="plan",input_sent=false};`);
  warm.push(`System.Func<object[],string> job=args=>{${await load('outcome.cs.txt')}};System.AppDomain.CurrentDomain.SetData("QaAgent.SharkWarm.outcome",job);return new{status="warmed",name="outcome",input_sent=false};`);
  // Keep compilation/setup sequential and outside the timed game response.
  const results=[];
  for(const body of warm)results.push((await session.batch([exec(body)],{checkErrors:false}))[0]);
  const installed=(await session.batch([exec(session.instrument(await load('reactor.cs.txt')))],{checkErrors:false}))[0];
  if(results.some(r=>r?.status!=='warmed')||installed?.status!=='installed_disarmed')throw new Error('Warm installation failed; no arming');
  return {status:'prepared_disarmed',jobs:results.map(r=>r.name),input_sent:false};
}
export async function setArmed(session,armed){
  return (await session.batch([exec(`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d==null)return new{status="not_installed"};if((bool)d["busy"])return new{status="busy_use_stop"};if(${armed?'true':'false'}&&(string)d["phase"]=="needs_review")return new{status="review_required"};d["armed"]=${armed?'true':'false'};return ((System.Func<object>)d["read"])();`)],{checkErrors:false}))[0];
}
export async function stopDefense(session){return (await session.batch([exec(`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d!=null)((System.Action)d["dispose"])();return new{status="stopped"};`)],{checkErrors:false}))[0];}
export async function readDefense(session){return (await session.batch([exec(READ)],{checkErrors:false}))[0];}
// Used by the shark quest too. This never forces an attack or changes quest/save data.
export async function defendCurrentAttack(session){return (await session.batch([exec(`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d==null)return new{status="not_installed"};if(!Survival.Ai.EnemyShark.SharkDetector.SharkAttackObserver.IsSharkAttack)return new{status="no_current_attack",input_sent=false};((System.Action)d["combat"])();return ((System.Func<object>)d["read"])();`)],{checkErrors:false}))[0];}
