import { writeFile } from 'node:fs/promises';
const KEY = 'QaAgent.AimEnemy.v1';
const exec = code => ({ tool: 'execute_code', params: { action: 'execute', code, safety_checks: true } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SET = `var a=System.IO.File.ReadAllLines(UnityEditor.SessionState.GetString("${KEY}.params",""));UnityEditor.SessionState.SetString("${KEY}.mode",a[0]);UnityEditor.SessionState.SetInt("${KEY}.target",int.Parse(a[1],System.Globalization.CultureInfo.InvariantCulture));return new{parameters_set=true,input_sent=false};`;
const READ = `var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;return d==null?(object)new{status="idle"}:d["result"];`;
const STOP = `var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d!=null&&!(bool)d["finished"])((System.Action)d["cancel"])();return d==null?(object)new{status="idle"}:d["result"];`;

// Candidate adaptation of the approved frame aiming; this class never attacks/moves.
export class AimEnemyAction {
  constructor(session, { source, parameterFile }) {
    this.session = session; this.code = session.instrument(source); this.parameterFile = parameterFile; this.running = false;
  }
  async prepare() {
    if (!this.session.active || this.running) throw new Error('A single active Unity session is required');
    await writeFile(this.parameterFile, 'prepare\n0\n');
    const results = await this.session.batch([
      exec(`UnityEditor.SessionState.SetString("${KEY}.params",${JSON.stringify(this.parameterFile)});return new{input_sent=false};`),
      exec(SET), exec(this.code),
    ]);
    if (results[2]?.status !== 'compiled_only' || results[2]?.input_sent !== false) throw new Error('No-input preparation failed');
    return results[2];
  }
  async stop() { return (await this.session.batch([exec(STOP)], { checkErrors: false }))[0]; }
  async run(targetInstanceId, { timeoutMs = 6500 } = {}) {
    if (!this.session.active || this.running) throw new Error('A single active Unity session is required');
    if (!Number.isSafeInteger(targetInstanceId) || !targetInstanceId) throw new Error('A current runtime instance ID is required');
    this.running = true;
    try {
      await writeFile(this.parameterFile, `aim\n${targetInstanceId}\n`);
      const [, ack] = await this.session.batch([exec(SET), exec(this.code)]);
      if (ack?.status !== 'running') return ack;
      const deadline = performance.now() + Math.max(1000, Math.min(timeoutMs, 7000));
      while (performance.now() < deadline) { await wait(80); const result = (await this.session.batch([exec(READ)]))[0]; if (result?.status !== 'running') return result; }
      return { status: 'host_timeout', cleanup: await this.stop() };
    } catch (error) { try { await this.stop(); } catch {} throw error; }
    finally { this.running = false; }
  }
}
