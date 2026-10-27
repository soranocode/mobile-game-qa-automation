// Human-approved consolidation of the observed UI checks. No arbitrary controls or purchases.
import { chooseKnownAction } from './skill.mjs';
const W={settings:'Survival.Views.UIView.UIPauseView',hud:'DamageShower.DamageShowView',
  dashboard:'Acme.Gui.Dashboard.UIDashboardView',map:'Survival.GlobalMap.MapView.MapComplex.MapComplexView',
  promo:'Survival.Views.UIView.UIEnterCodeView',popup:'Survival.Windows.Popups.UIPopupView'};
const KNOWN=new Set(Object.values(W));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const has=(s,w)=>s.windows.includes(w);
const near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<0.0001;
function stop(message,code='UNKNOWN_UI',state) {const e=new Error(message);e.code=code;e.state=state;throw e;}
export function validateSettingsState(s,{popup=null,promo=false}={}) {
  if(!Array.isArray(s?.windows)||!Array.isArray(s?.scenes))stop('Incomplete UI state','INCOMPLETE_UI',s);
  if(!s.playing||!s.scenes.includes('Game'))stop('This profile requires gameplay, not the main menu','UNSUPPORTED_CONTEXT',s);
  if(s.version!=='2.11.0')stop('Unverified build for the learned settings profile','UNSUPPORTED_BUILD',s);
  if(s.windows.some(w=>!KNOWN.has(w)))stop('Unexpected window','UNKNOWN_UI',s);
  if(has(s,W.popup)&&(!popup||s.popup_intent!==popup))stop('Unexpected confirmation','UNKNOWN_UI',s);
  if(has(s,W.promo)&&!promo)stop('Unexpected promo-code window','UNKNOWN_UI',s);
}
export function baselineMatches(s,b) {
  return near(s.graphics,b.graphics)&&near(s.sensitivity,b.sensitivity)&&
    ['effects','music','vibration','fps','language','target_fps'].every(k=>s[k]===b[k]);
}
export async function ensureKnownSettings(session,deadline=performance.now()+5000) {
  let state=await session.observe(),lastSent;
  while(performance.now()<deadline) {
    if(state.windows?.includes(W.settings))return state;
    const decision=chooseKnownAction(state);
    if(decision.halt||!['open_menu','open_settings'].includes(decision.role))
      stop('Unknown route to gameplay settings','UNKNOWN_UI',state);
    if(decision.wait||decision.role===lastSent){await sleep(20);state=await session.observe();continue;}
    const step=await session.step(decision.role);state=step.state;
    if(step.input.status==='sent')lastSent=decision.role;
    else if(['not_sent_blocked','not_sent_covered'].includes(step.input.status)){await sleep(25);state=await session.observe();}
    else stop('Input outcome unknown; do not replay','INPUT_UNKNOWN',state);
  }
  stop('Settings route timed out','TIMEOUT',state);
}

export async function runApprovedSettingsChecks(adapter,{expectedErrors=[],timeoutMs=20000}={}) {
  if(!adapter.prepared)throw Error('Prepare the approved settings adapter before running');
  const session=adapter.session,started=performance.now(),deadline=started+Math.min(45000,Math.max(2000,timeoutMs));
  const report={result:'NEEDS_REVIEW',profile:'approved-gameplay-settings-ui-v1',checks:[],events:[],restoration_pending:[],
    skipped:['Editor login and purchase restoration','External support/social/legal destinations',
      'Actual audio/vibration/camera/rendering effects','Promo-code activation','Progress deletion','Main menu settings']};
  let baseline;
  const originalEvent=adapter.onEvent;
  adapter.onEvent=e=>{report.events.push(e);originalEvent(e);};
  const validate=(state,allowed)=>{
    if(performance.now()>deadline)stop('Settings check deadline exceeded','TIMEOUT',state);
    validateSettingsState(state,allowed);
  };
  const click=(id,expect,opts={})=>adapter.click(id,{...opts,expect,validate:s=>validate(s,opts)});
  const pass=(check,observed)=>report.checks.push({check,result:'PASS_UI',...observed});
  try {
    await session.begin({expectedErrors});
    await ensureKnownSettings(session,Math.min(deadline,performance.now()+5000));
    baseline=await adapter.snapshot();validate(baseline);
    if(!has(baseline,W.settings)||!Number.isFinite(baseline.graphics)||!Number.isFinite(baseline.sensitivity)||
      baseline.graphics<0||baseline.graphics>2||baseline.sensitivity<0.5||baseline.sensitivity>6||
      ['effects','music','vibration','fps','language'].some(k=>typeof baseline[k]!=='string'||!baseline[k]))
      stop('Incomplete baseline','INCOMPLETE_UI',baseline);
    report.baseline=baseline;
    for(const id of ['effects','music','vibration','fps']) {
      report.restoration_pending.push({id,value:baseline[id]});
      const changed=await click(id,s=>typeof s[id]==='string'&&s[id]!==baseline[id]&&
        (id!=='fps'||Number(s.fps)===s.target_fps));
      await click(id,s=>s[id]===baseline[id]&&(id!=='fps'||s.target_fps===baseline.target_fps));
      report.restoration_pending.pop();pass(id,{before:baseline[id],changed:changed[id],restored:baseline[id]});
    }
    for(const spec of [{id:'graphics',min:0,max:2,values:[0,1,2],fractions:[0.02,0.5,0.98]},
      {id:'sensitivity',min:0.5,max:6,values:[1.6,4.9],fractions:[0.2,0.8]}]) {
      report.restoration_pending.push({id:spec.id,value:baseline[spec.id]});
      const values=[];
      for(let i=0;i<spec.values.length;i++) {
        const state=await click(spec.id,s=>near(s[spec.id],spec.values[i]),{fraction:spec.fractions[i]});
        values.push(state[spec.id]);
      }
      await click(spec.id,s=>near(s[spec.id],baseline[spec.id]),{fraction:(baseline[spec.id]-spec.min)/(spec.max-spec.min)});
      report.restoration_pending.pop();pass(spec.id,{values,restored:baseline[spec.id],scope:'UI values only'});
    }
    report.restoration_pending.push({id:'language',value:baseline.language});
    const other=await click('language_next',s=>typeof s.language==='string'&&s.language!==baseline.language);
    await click('language_previous',s=>s.language===baseline.language);
    report.restoration_pending.pop();pass('language',{before:baseline.language,changed:other.language,restored:baseline.language});
    await click('promo_open',s=>has(s,W.promo),{promo:true});
    await click('promo_close',s=>!has(s,W.promo)&&has(s,W.settings),{promo:true});
    pass('promo open/close');
    for(const [id,intent] of [['new_game_open','new_game'],['exit_open','exit']]) {
      await click(id,s=>has(s,W.popup)&&s.popup_intent===intent,{popup:intent});
      await click('cancel_popup',s=>!has(s,W.popup)&&has(s,W.settings),{popup:intent});
      pass(intent+' cancel');
    }
    const restored=await adapter.snapshot();validate(restored);
    if(!baselineMatches(restored,baseline))stop('Baseline not restored','UI_OUTCOME_MISMATCH',restored);
    pass('restore baseline');report.settings_restored=true;
    await click('close_settings',s=>!has(s,W.settings));pass('close settings returns to game');
    await ensureKnownSettings(session,Math.min(deadline,performance.now()+5000));
    const reopened=await adapter.snapshot();validate(reopened);
    if(!has(reopened,W.settings)||!baselineMatches(reopened,baseline))stop('Settings changed on reopen','UI_OUTCOME_MISMATCH',reopened);
    pass('reopen retains restored values');
    await click('close_settings',s=>!has(s,W.settings));
    report.final_state=await adapter.snapshot();validate(report.final_state);
    report.result='PASS_UI_SCOPE';
  } catch(e) {
    report.reason=e.code==='UNITY_NEW_ERROR'?'new_unity_error':e.code??'transport_or_session_error';
    report.failure=String(e);report.unexpected_state=e.state;report.error_alert=e.alert;
    if(e.code==='UNITY_NEW_ERROR')try{report.error_details=await session.errors.details();}catch(error){report.details_failure=String(error);}
  } finally {
    adapter.onEvent=originalEvent;
    try {
      report.cleanup=await session.finish();
      if(report.cleanup?.error_watch?.blocked) {report.result='NEEDS_REVIEW';report.reason='new_unity_error';
        if(!report.error_details)report.error_details=await session.errors.details();}
    } catch(e) {report.result='NEEDS_REVIEW';report.cleanup_error=String(e);}
    report.elapsed_seconds=Number(((performance.now()-started)/1000).toFixed(3));
  }
  return report;
}
