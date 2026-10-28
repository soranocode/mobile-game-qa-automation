// One assistant-selected UI action per step, guarded by passive Unity error events.
import { UnityErrorMonitor, NewUnityError, ERROR_WATCH_SNAPSHOT,
  armErrorMonitorCode, DISARM_ERROR_MONITOR, validateExpectedErrors } from './error-monitor.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const PREFIX = 'QaAgent.FastUi.';
const EXEC = code => ({ tool: 'execute_code', params: { action: 'execute', code, safety_checks: true, compiler: 'auto' } });
const ROLES = new Set(['open_menu', 'open_settings', 'start_new_game', 'confirm_new_game',
  'exit_to_main_menu', 'confirm_exit', 'close_premium', 'close_discord', 'skip_intro_build', 'skip_intro_survive']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const LIFECYCLE_WARMUP='if(UnityEditor.SessionState.GetBool("QaAgent.FastUi.lifecycle_warmup",false))return new{status="compiled_only",input_sent=false};';
const cycleSnapshotCode=LIFECYCLE_WARMUP+ERROR_WATCH_SNAPSHOT+'return new{error_watch=errorWatchSnapshot()};';
const cycleStartCode=`${LIFECYCLE_WARMUP}
if(UnityEditor.SessionState.GetBool("QaAgent.FastUi.active",false)||UnityEditor.SessionState.GetBool("QaAgent.FastUi.cycle_active",false))return new{status="already_active"};
${ERROR_WATCH_SNAPSHOT}
${armErrorMonitorCode([]).replace(/\bwatch\b/g,'cycleWatchState').replace('return new { armed = true, expected_rules = 0 };','')}
UnityEditor.SessionState.SetBool("QaAgent.FastUi.cycle_previous_background",UnityEngine.Application.runInBackground);
UnityEditor.SessionState.SetBool("QaAgent.FastUi.cycle_active",true);
UnityEditor.SessionState.SetString("QaAgent.FastUi.cycle_owner","__CYCLE_OWNER__");
UnityEditor.SessionState.SetString("QaAgent.FastUi.cycle_error_epoch",(string)cycleWatchState["epoch"]);
UnityEngine.Application.runInBackground=true;
return new{status="cycle_begun",error_watch=errorWatchSnapshot()};`;
const cycleEndCode=`${LIFECYCLE_WARMUP}${ERROR_WATCH_SNAPSHOT}
if(!UnityEditor.SessionState.GetBool("QaAgent.FastUi.cycle_active",false))return new{status="cycle_absent",error_watch=errorWatchSnapshot()};
if(UnityEditor.SessionState.GetString("QaAgent.FastUi.cycle_owner","")!="__CYCLE_OWNER__")return new{status="cycle_foreign",error_watch=errorWatchSnapshot()};
var snapshot=errorWatchSnapshot();
UnityEditor.SessionState.SetInt("QaAgent.FastUi.sequence",UnityEditor.SessionState.GetInt("QaAgent.FastUi.sequence",0)+1);
UnityEditor.SessionState.SetBool("QaAgent.FastUi.active",false);
UnityEditor.SessionState.SetBool("QaAgent.FastUi.warmup",true);
UnityEngine.Application.runInBackground=UnityEditor.SessionState.GetBool("QaAgent.FastUi.cycle_previous_background",false);
UnityEditor.SessionState.SetBool("QaAgent.FastUi.cycle_active",false);
UnityEditor.SessionState.SetString("QaAgent.FastUi.cycle_owner","");
UnityEditor.SessionState.SetString("QaAgent.FastUi.cycle_error_epoch","");
${DISARM_ERROR_MONITOR.replace(/\bwatch\b/g,'cycleDisarmState').replace('return new { disarmed = true };','')}
return new{status="cycle_finished",error_watch=snapshot};`;
const beginCode=(held,rules=[])=>`${held?LIFECYCLE_WARMUP:''}const string p = "${PREFIX}";
if (UnityEditor.SessionState.GetBool(p + "active", false)) return new { status = "already_active" };
${held?`${ERROR_WATCH_SNAPSHOT}
var heldWatch=System.AppDomain.CurrentDomain.GetData("QaAgent.ErrorWatch.v1") as System.Collections.Generic.Dictionary<string,object>;
if(heldWatch==null||errorWatchBlocked()||(string)heldWatch["epoch"]!=UnityEditor.SessionState.GetString(p+"cycle_error_epoch",""))return new{status="blocked_new_error",error_watch=errorWatchSnapshot()};`
:'if(UnityEditor.SessionState.GetBool(p+"cycle_active",false))return new{status="already_active"};'}
UnityEditor.SessionState.SetBool(p + "previous_background", UnityEngine.Application.runInBackground);
UnityEditor.SessionState.SetBool(p + "active", true);
UnityEditor.SessionState.SetBool(p + "warmup", false);
UnityEngine.Application.runInBackground = true;
UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
${held?'':armErrorMonitorCode(rules).replace('return new { armed = true, expected_rules = '+rules.length+' };','')}
return new { status = "begun" };`;
const finishCode=held=>`${held?LIFECYCLE_WARMUP:''}${ERROR_WATCH_SNAPSHOT}
const string p = "${PREFIX}";
UnityEditor.SessionState.SetInt(p + "sequence", UnityEditor.SessionState.GetInt(p + "sequence", 0) + 1);
UnityEditor.SessionState.SetString(p + "status", "stopped");
if (UnityEditor.SessionState.GetBool(p + "active", false))
    UnityEngine.Application.runInBackground = UnityEditor.SessionState.GetBool(p + "previous_background", false);
UnityEditor.SessionState.SetBool(p + "active", false);
UnityEditor.SessionState.SetBool(p + "warmup", true);
${held?'var heldWatch=System.AppDomain.CurrentDomain.GetData("QaAgent.ErrorWatch.v1") as System.Collections.Generic.Dictionary<string,object>;if(heldWatch!=null)lock(heldWatch["gate"])heldWatch["phase"]="handoff";':''}
return new { stopped = true, run_in_background = UnityEngine.Application.runInBackground,
    error_watch = errorWatchSnapshot() };`;
export const cycleLifecycleCommands=(owner='offline-verifier')=>Object.freeze([cycleStartCode,beginCode(true),finishCode(true),cycleEndCode,cycleSnapshotCode].map(code=>code.replaceAll('__CYCLE_OWNER__',owner)));

export class FastUiSession {
  #scope=new AsyncLocalStorage();
  #owner=null;
  #cycleWatch=false;
  #cycleEpoch=null;
  #lifecycle=cycleLifecycleCommands(randomUUID());
  #recovery=null;
  #recoverAllowed=false;
  #recovering=null;
  constructor(invokeTool, code) {
    this.listeners = new Set();
    this.telemetryErrors = [];
    this.toolSequence = 0;
    this.executionGuard = null;
    this.invoke = async (tool,args,{checkGuard=true}={}) => {
      this.assertOwner();
      const id=++this.toolSequence,started=performance.now();
      let attempted=false;
      this.emit({type:'mcp_start',tool,id});
      try {
        if(checkGuard)this.executionGuard?.();
        attempted=true;
        const result=await invokeTool(tool,args);
        const values=Array.isArray(result?.data?.results)?result.data.results.map(r=>r.result?.data?.result):[result?.data?.result];
        const outcomes=values.filter(v=>v&&typeof v==='object').map(v=>({
          status:typeof v.status==='string'?v.status.slice(0,80):null,
          role:typeof v.role==='string'?v.role.slice(0,80):null,
          input_sent:typeof v.input_sent==='boolean'?v.input_sent:null,
          blocked:v.error_watch?.blocked===true}));
        this.emit({type:'mcp_end',tool,id,ms:performance.now()-started,ok:result?.success===true,transport_attempted:true,outcomes});
        return result;
      } catch(error) {
        this.emit({type:'mcp_end',tool,id,ms:performance.now()-started,ok:false,transport_attempted:attempted,error_code:error?.code??error?.name??'Error'});
        throw error;
      }
    };
    this.code = code;
    this.active = false;
    this.timings = [];
    this.errors = new UnityErrorMonitor(this.invoke);
  }

  subscribe(listener) {
    if(typeof listener!=='function')throw Error('Telemetry listener required');
    this.listeners.add(listener);
    return ()=>this.listeners.delete(listener);
  }

  get cycleActive(){return this.#owner!==null;}
  assertOwner(){
    const current=this.#scope.getStore();
    if(current&&(current.owner!==this.#owner||current.expired))throw Error('Cycle session lease expired');
    if(this.#owner!==null&&current?.owner!==this.#owner)throw Error('Cycle owns this Unity session');
  }
  checkCycleSnapshot(watch){
    this.assertOwner();
    if(!this.#cycleWatch||watch?.available!==true||watch.armed!==true||watch.epoch!==this.#cycleEpoch||watch.blocked){
      this.errorAlert=watch;throw new NewUnityError(watch);
    }
  }
  claimCycle(token){
    if(!token||this.#owner!==null||this.active)throw Error('Idle session required for a single cycle owner');
    this.#owner=token;
    const root={owner:token,expired:false};
    const scoped=scope=>fn=>{if(this.#owner!==token||scope.expired)throw Error('Cycle session lease expired');return this.#scope.run(scope,fn);};
    const run=scoped(root);
    const control=Object.freeze({run,
      createMission:()=>{
        const scope={owner:token,expired:false};
        return Object.freeze({run:scoped(scope),close:()=>{scope.expired=true;}});
      },
      begin:()=>run(async()=>{
        this.errorAlert=undefined;
        await this.errors.install();
        // A lost acknowledgment may still mean that Unity armed the watcher.
        this.#cycleWatch=true;
        const [state]=await this.batch([EXEC(this.#lifecycle[0])],{checkErrors:false,checkGuard:true});
        this.assertOwner();
        if(state?.status==='already_active'){this.#cycleWatch=false;throw Error('Another Unity cycle is active');}
        if(state?.status!=='cycle_begun')throw Error('Cycle start was not confirmed');
        this.#cycleEpoch=state.error_watch?.epoch;
        this.checkCycleSnapshot(state.error_watch);
      }),
      check:()=>run(async()=>{
        const [state]=await this.batch([EXEC(this.#lifecycle[4])]);
        this.checkCycleSnapshot(state?.error_watch);
      }),
      finish:()=>run(async()=>{
        if(this.active)await this.finish();
        if(!this.#cycleWatch)return;
        const [state]=await this.batch([EXEC(this.#lifecycle[3])],{checkErrors:false});
        this.assertOwner();
        if(!['cycle_finished','cycle_absent'].includes(state?.status))throw Error('Cycle cleanup not confirmed; retain the session lease');
        const epoch=this.#cycleEpoch;
        this.#cycleWatch=false;this.#cycleEpoch=null;this.active=false;
        if(state.status==='cycle_finished'&&(state.error_watch?.available!==true||(epoch&&state.error_watch.epoch!==epoch)||state.error_watch.blocked))throw new NewUnityError(state?.error_watch);
      }),
      release:()=>{
        if(this.#owner!==token)throw Error('Cycle session lease expired');
        if(this.active||this.#cycleWatch){this.#recoverAllowed=true;throw Error('Finish cycle cleanup first');}
        root.expired=true;this.#owner=null;this.#recovery=null;this.#recoverAllowed=false;
      }
    });
    this.#recovery=control;return control;
  }

  async recoverStoppedCycle(){
    if(this.#recovering)return this.#recovering;
    if(!this.#recovery||!this.#recoverAllowed)throw Error('No retained stopped cycle cleanup');
    const control=this.#recovery;
    this.#recovering=(async()=>{
      let warning;
      try{await control.finish();}catch(error){warning=String(error).slice(0,300);}
      control.release();
      return{status:'cycle_cleanup_confirmed',input_sent:false,...(warning?{warning}:{})};
    })();
    try{return await this.#recovering;}finally{this.#recovering=null;}
  }

  async prepareCyclePrimitives(){
    this.assertOwner();
    if(this.active||this.#owner!==null)throw Error('Warm cycle lifecycle before execution');
    const setting=value=>EXEC(`UnityEditor.SessionState.SetBool("QaAgent.FastUi.lifecycle_warmup",${value});return new{input_sent=false};`);
    try{
      const values=await this.batch([setting(true),...this.#lifecycle.map(EXEC)]);
      if(!values.slice(1).every(v=>v?.status==='compiled_only'))throw Error('Cycle lifecycle preparation was not input-free');
      return{compiled:5,input_sent:false};
    }finally{await this.batch([setting(false)],{checkErrors:false});}
  }

  guard(check) {
    if(typeof check!=='function'||this.executionGuard)throw Error('A single cycle guard is required');
    this.executionGuard=check;
    return ()=>{if(this.executionGuard===check)this.executionGuard=null;};
  }

  emit(event) {
    for(const listener of this.listeners)try{listener(Object.freeze(event));}
    catch(error){this.telemetryErrors.push(String(error).slice(0,200));}
  }

  body(role) {
    if (role !== 'observe' && !ROLES.has(role)) throw new Error('Unknown single UI action');
    return this.instrument(this.code.replace('__ROLE__', role));
  }

  instrument(code) {
    if (!code.includes('__ERROR_WATCH_SETUP__')) throw new Error('UI template is missing the error watcher guard');
    return code.replace('__ERROR_WATCH_SETUP__', ERROR_WATCH_SNAPSHOT);
  }

  async batch(commands, { checkErrors = true, checkGuard = checkErrors } = {}) {
    this.assertOwner();
    const started = performance.now();
    const result = await this.invoke('batch_execute', { commands, parallel: false, fail_fast: true }, {checkGuard});
    this.timings.push({ kind: 'batch', calls: commands.length, ms: performance.now() - started });
    if (!result?.success || !Array.isArray(result.data?.results)) throw new Error('MCP batch failed; do not retry input blindly');
    const values = result.data.results.map(item => {
      if (!item.callSucceeded || !item.result?.success) throw new Error('Unity operation failed; observe before retrying input');
      return item.result.data?.result;
    });
    const alert = values.find(value => value?.status === 'blocked_new_error' ||
      value?.error_watch?.blocked || value?.error_watch?.available === false);
    if (checkErrors && alert) {
      this.errorAlert = { ...alert.error_watch, input_status: alert.status,
        selected_role: alert.selected_role ?? alert.role };
      throw new NewUnityError(this.errorAlert);
    }
    return values;
  }

  async prepare() {
    this.assertOwner();
    if (this.active||this.#owner!==null) throw new Error('Finish the current UI session before preparing commands');
    const setWarmup = EXEC(`UnityEditor.SessionState.SetBool("${PREFIX}warmup", true); return new { input_sent = false };`);
    const results = await this.batch([setWarmup, ...[...ROLES, 'observe'].map(role => EXEC(this.body(role)))]);
    if (!results.slice(1).every(r => r?.status === 'compiled_only' && r.input_sent === false))
      throw new Error('Compilation-only preparation did not return the expected guard');
    return { compiled: ROLES.size + 1, input_sent: false };
  }

  async begin({ expectedErrors = [] } = {}) {
    this.assertOwner();
    if (this.active) throw new Error('UI session already active');
    validateExpectedErrors(expectedErrors);
    if(this.#cycleWatch&&expectedErrors.length)throw Error('Do not change error exceptions during a cycle');
    if(!this.#cycleWatch){this.errorAlert=undefined;await this.errors.install();}
    const setup=beginCode(this.#cycleWatch,expectedErrors);
    const [ack, state] = await this.batch([EXEC(setup), EXEC(this.body('observe'))]);
    if (ack?.status !== 'begun') throw new Error('Another UI session is active; no input sent');
    this.active = true;
    return state;
  }

  async observe() {
    return (await this.batch([EXEC(this.body('observe'))]))[0];
  }

  async step(role, waitMs = 450) {
    this.assertOwner();
    if (!this.active) throw new Error('Begin the UI session before input');
    if (this.errorAlert) throw new NewUnityError(this.errorAlert);
    if (!ROLES.has(role)) throw new Error('Unsupported single UI action');
    const [ack, firstState] = await this.batch([EXEC(this.body(role)), EXEC(this.body('observe'))]);
    if (ack?.status !== 'pending') return { input: ack, state: firstState };
    let state = firstState;
    const deadline = performance.now() + Math.max(0, Math.min(waitMs, 800));
    // Wait for the already-chosen action only. Never select or repeat a click.
    while (state?.status === 'pending' && performance.now() < deadline) {
      await delay(20);
      state = await this.observe();
    }
    return { input: { role, status: state?.status ?? 'unknown' }, state };
  }

  async finish() {
    this.assertOwner();
    // Invalidate a delayed coroutine before it can act after stop/timeout.
    const code=finishCode(this.#cycleWatch);
    try {
      return (await this.batch([EXEC(code), ...(this.#cycleWatch?[]:[EXEC(DISARM_ERROR_MONITOR)])], { checkErrors: false }))[0];
    } finally { this.active = false; }
  }
}
