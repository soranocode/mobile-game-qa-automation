// Read-only regression against live Unity colliders; never creates objects or sends input.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export async function runCollisionPolicySelfTest(session) {
  const files=['route-driver.cs.txt','raft-snapshot-fast.cs.txt','../shark-defense/plan.cs.txt'];
  const sources=await Promise.all(files.map(name=>readFile(fileURLToPath(new URL(name,import.meta.url)),'utf8')));
  const policies=sources.map(source=>source.match(/\/\/ COLLISION_POLICY_BEGIN\r?\n([\s\S]*?)\/\/ COLLISION_POLICY_END/)?.[1]?.trim());
  if(!policies[0]||policies.some(policy=>policy!==policies[0]))throw Error('Map, route and defense collision policies differ');
  const code=`var movement=UnityEngine.Object.FindObjectOfType<Survival.Views.Movement>();
if(movement==null)return new{passed=false,reason="no_player",input_sent=false};
var cc=movement.GetComponent<UnityEngine.CharacterController>();
if(cc==null)return new{passed=false,reason="no_controller",input_sent=false};
${policies[0]}
var resources=UnityEngine.Object.FindObjectsByType<Survival.Controllers.WaterPickableComponent>(UnityEngine.FindObjectsSortMode.None).SelectMany(w=>w.GetComponentsInChildren<UnityEngine.Collider>(false)).Where(c=>c.enabled).ToArray();
var floating=resources.Where(c=>!c.isTrigger).ToArray();
var triggers=resources.Where(c=>c.isTrigger).ToArray();
var solids=UnityEngine.Object.FindObjectsByType<UnityEngine.BoxCollider>(UnityEngine.FindObjectsSortMode.None).Where(c=>c.enabled&&!c.isTrigger&&c.gameObject.activeInHierarchy&&c.gameObject.scene==movement.gameObject.scene&&c.name.IndexOf("foundation",System.StringComparison.OrdinalIgnoreCase)>=0).ToArray();
bool floatingIgnored=floating.Length>0&&floating.All(c=>UnityEngine.Physics.GetIgnoreLayerCollision(cc.gameObject.layer,c.gameObject.layer)&&!collisionEnabled(c));
bool triggerIgnored=triggers.Length>0&&triggers.All(c=>!collisionEnabled(c));
bool solidsRetained=solids.Length>0&&solids.All(c=>collisionEnabled(c));
return new{passed=floatingIgnored&&triggerIgnored&&solidsRetained&&!collisionEnabled(null),input_sent=false,shared_policy=true,floating_ignored=floatingIgnored,floating_colliders=floating.Length,triggers_ignored=triggerIgnored,trigger_colliders=triggers.Length,solids_retained=solidsRetained,solid_colliders=solids.Length};`;
  return (await session.batch([{tool:'execute_code',params:{action:'execute',code,safety_checks:true}}]))[0];
}
