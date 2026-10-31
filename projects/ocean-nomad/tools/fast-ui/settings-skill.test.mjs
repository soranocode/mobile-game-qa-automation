import test from 'node:test';
import assert from 'node:assert/strict';
import { runApprovedSettingsChecks,validateSettingsState,baselineMatches } from './settings-skill.mjs';
const S='Survival.Views.UIView.UIPauseView',H='DamageShower.DamageShowView',P='Survival.Windows.Popups.UIPopupView',C='Survival.Views.UIView.UIEnterCodeView';
const initial=()=>({windows:[S,H],scenes:['Game'],playing:true,version:'2.11.0',status:'sent',
  graphics:1,sensitivity:3,effects:'ВКЛ',music:'ВКЛ',vibration:'ВЫКЛ',fps:'60',target_fps:60,language:'РУССКИЙ',popup_intent:null});
function fixture({errorOnFirstClick=false}={}) {
  const state=initial(),clicked=[];let cleaned=false,detailsRead=0;
  const session={active:false,async begin(){this.active=true;},
    async observe(){return {windows:state.windows,scenes:state.scenes,controls:[]};},
    async finish(){this.active=false;cleaned=true;return {stopped:true,error_watch:{blocked:false}};},
    errors:{async details(){detailsRead++;return {entries:[{message:'new unexpected error'}]};}}};
  const adapter={prepared:true,session,onEvent:()=>{},async snapshot(){return structuredClone(state);},
    async click(id,{fraction,expect,validate}) {
      validate(state);clicked.push(id);
      if(errorOnFirstClick){const e=new Error('new error');e.code='UNITY_NEW_ERROR';throw e;}
      if(['effects','music','vibration'].includes(id))state[id]=state[id]==='ВКЛ'?'ВЫКЛ':'ВКЛ';
      else if(id==='fps'){state.fps=state.fps==='60'?'30':'60';state.target_fps=Number(state.fps);}
      else if(id==='graphics')state.graphics=Math.round(fraction*2);
      else if(id==='sensitivity')state.sensitivity=0.5+fraction*5.5;
      else if(id==='language_next')state.language='ENGLISH';
      else if(id==='language_previous')state.language='РУССКИЙ';
      else if(id==='promo_open')state.windows=[C,S,H];
      else if(id==='promo_close')state.windows=[S,H];
      else if(id==='new_game_open'||id==='exit_open'){state.windows=[P,S,H];state.popup_intent=id==='new_game_open'?'new_game':'exit';}
      else if(id==='cancel_popup'){state.windows=[S,H];state.popup_intent=null;}
      else if(id==='close_settings')state.windows=[H];
      else throw Error('Unexpected action '+id);
      validate(state);assert.equal(expect(state),true,id+' expected outcome');
      return structuredClone(state);
    }};
  // Reopening is a fixture capability, not a private game callback in production.
  session.observe=async()=>{if(!state.windows.includes(S))state.windows=[S,H];return {windows:state.windows,scenes:state.scenes,controls:[]};};
  return {adapter,clicked,state,cleaned:()=>cleaned,detailsRead:()=>detailsRead};
}
test('unknown windows, unrelated confirmations and other builds stop',()=>{
  assert.throws(()=>validateSettingsState({...initial(),windows:['UnfamiliarOffer']}),e=>e.code==='UNKNOWN_UI');
  assert.throws(()=>validateSettingsState({...initial(),windows:[P,S],popup_intent:'purchase'},{popup:'new_game'}),e=>e.code==='UNKNOWN_UI');
  assert.throws(()=>validateSettingsState({...initial(),version:'other'}),e=>e.code==='UNSUPPORTED_BUILD');
  assert.equal(baselineMatches({...initial(),target_fps:30},initial()),false);
});
test('consolidated profile completes the 13 learned assertions and restores the baseline',async()=>{
  const f=fixture(),r=await runApprovedSettingsChecks(f.adapter);
  assert.equal(r.result,'PASS_UI_SCOPE');assert.equal(r.checks.length,13);
  assert.equal(baselineMatches(f.state,initial()),true);assert.equal(f.cleaned(),true);
  assert.equal(f.clicked.includes('confirm_new_game'),false);assert.equal(f.clicked.includes('login'),false);
  assert.equal(f.clicked.filter(id=>id==='cancel_popup').length,2);
});
test('a new red error aborts, reads only its details, and never sends the next control',async()=>{
  const f=fixture({errorOnFirstClick:true}),r=await runApprovedSettingsChecks(f.adapter);
  assert.equal(r.result,'NEEDS_REVIEW');assert.equal(r.reason,'new_unity_error');
  assert.deepEqual(f.clicked,['effects']);assert.equal(f.detailsRead(),1);assert.equal(f.cleaned(),true);
  assert.equal(r.restoration_pending.length,1);
});
test('a final-boundary error overrides an otherwise successful settings test',async()=>{
  const f=fixture();f.adapter.session.finish=async()=>({stopped:true,error_watch:{blocked:true}});
  const r=await runApprovedSettingsChecks(f.adapter);
  assert.equal(r.result,'NEEDS_REVIEW');assert.equal(r.reason,'new_unity_error');assert.equal(f.detailsRead(),1);
});
