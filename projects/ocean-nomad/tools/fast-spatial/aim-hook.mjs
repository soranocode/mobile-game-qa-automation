import { writeFile } from 'node:fs/promises';

const KEY = 'QaAgent.AimHook.v1';
const exec = code => ({ tool: 'execute_code', params: { action: 'execute', code, safety_checks: true } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SET = `var a=System.IO.File.ReadAllLines(UnityEditor.SessionState.GetString("${KEY}.params",""));
UnityEditor.SessionState.SetString("${KEY}.mode",a[0]);
UnityEditor.SessionState.SetInt("${KEY}.target",int.Parse(a[1],System.Globalization.CultureInfo.InvariantCulture));
UnityEditor.SessionState.SetString("${KEY}.trajectory",a.Length>2?a[2]:"direct");
return new{parameters_set=true,input_sent=false};`;
const READ = `var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
return d==null?(object)new{status="idle"}:d["result"];`;
const STOP = `var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
if(d!=null&&!(bool)d["finished"])((System.Action)d["cancel"])();
return d==null?(object)new{status="idle"}:d["result"];`;

// The assistant selects the quest/target. This bounded MCP action does one aim + one click.
export class AimHookAction {
  constructor(session, { source, parameterFile }) {
    this.session = session;
    this.code = session.instrument(source);
    this.parameterFile = parameterFile;
    this.running = false;
  }

  async stop() { return (await this.session.batch([exec(STOP)], { checkErrors: false }))[0]; }

  async run(targetInstanceId, { aimOnly = false, timeoutMs = 14000, trajectory = 'direct' } = {}) {
    if (!this.session.active || this.running) throw new Error('A single active Unity session is required');
    if (!Number.isSafeInteger(targetInstanceId) || !targetInstanceId) throw new Error('A current runtime instance ID is required');
    if (!['direct', 'ballistic'].includes(trajectory)) throw new Error('Unknown trajectory');
    this.running = true;
    try {
      await writeFile(this.parameterFile, `${aimOnly ? 'aim' : 'collect'}\n${targetInstanceId}\n${trajectory}\n`);
      const [, ack] = await this.session.batch([exec(`UnityEditor.SessionState.SetString("${KEY}.params",${JSON.stringify(this.parameterFile)});
${SET}`), exec(this.code)]);
      if (ack?.status !== 'running') return ack;
      const deadline = performance.now() + Math.max(1000, Math.min(timeoutMs, 15000));
      while (performance.now() < deadline) {
        await sleep(120);
        const result = (await this.session.batch([exec(READ)]))[0];
        if (result?.status !== 'running') return result;
      }
      const cleanup = await this.stop();
      return { status: 'host_timeout', cleanup };
    } catch (error) {
      // A failed transport never replays a click. Cancel our own controller only.
      try { await this.stop(); } catch { /* Report the original unknown outcome. */ }
      throw error;
    } finally { this.running = false; }
  }
}

export function chooseHookTarget(snapshot, excluded = new Set()) {
  const q = snapshot?.quests?.active_quests?.find(q => q.uid === 'hook_use');
  if (!q?.steps?.some(s => s.uid === 'use_wooden_hook' && s.active && !s.is_complete)) return null;
  const uids = new Set(snapshot.quests.active_collect_target_uids);
  return snapshot.spatial.targets
    .filter(t => uids.has(t.uid) && t.active_in_hierarchy && !t.is_taken && !excluded.has(t.instance_id))
    .sort((a, b) => Math.abs(a.yaw_error_degrees_positive_right) - Math.abs(b.yaw_error_degrees_positive_right) || a.distance_from_camera - b.distance_from_camera)[0] ?? null;
}
