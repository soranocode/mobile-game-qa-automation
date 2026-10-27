import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const PREFIX = 'CanvasInterface/UIPause/';
const BOTTOM = PREFIX+'Panel/Elements/BottomElements/';
const SWITCH = PREFIX+'Panel/Elements/Settings/Contents/';
const TARGETS = Object.freeze({
  effects:SWITCH+'Effects/UISettingsSwitch', music:SWITCH+'Music/UISettingsSwitch',
  vibration:SWITCH+'Vibration/UISettingsSwitch', fps:SWITCH+'FPS/UISettingsSwitch',
  graphics:PREFIX+'Panel/Elements/Graphics/SliderGraphics',
  sensitivity:PREFIX+'Panel/Elements/Sensitivity/SliderSensivity',
  language_next:BOTTOM+'LanguageSwitch/Language/ArrowRight',
  language_previous:BOTTOM+'LanguageSwitch/Language/ArrowLeft',
  promo_open:BOTTOM+'EnterCode', promo_close:'CanvasController/UIPopupEnterCode/Main/UIPopupTitle/Content/UIButtonClose',
  new_game_open:BOTTOM+'NewGame', exit_open:BOTTOM+'MainMenu',
  cancel_popup:'CanvasController/UIPopupDefault/Main/Contents/Buttons/UIButtonGreen(Clone)',
  close_settings:PREFIX+'Panel/Close_Button',
});
const exec = code => ({tool:'execute_code',params:{action:'execute',code,safety_checks:true,compiler:'auto'}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class SettingsOutcomeError extends Error {
  constructor(message,state) { super(message);this.code='UI_OUTCOME_MISMATCH';this.state=state; }
}
export class SettingsAdapter {
  constructor(session,{parameterFile,inputCode,parameterCode,snapshotCode,onEvent=()=>{}}) {
    if(!isAbsolute(parameterFile)) throw Error('UI parameter file must be absolute');
    this.session=session;this.parameterFile=parameterFile;this.onEvent=onEvent;
    this.inputCode=session.instrument(inputCode);
    this.parameterCode=session.instrument(parameterCode);
    this.snapshotCode=session.instrument(snapshotCode);
    this.prepared=false;
  }
  async prepare() {
    if(this.session.active)throw Error('Prepare before starting the UI session');
    // One fixed parameter file per local controller. Runtime values never become new C# source.
    await writeFile(this.parameterFile,TARGETS.close_settings+'\n0.5','utf8');
    const setup=`UnityEditor.SessionState.SetBool("QaAgent.FastUi.warmup", true);
UnityEditor.SessionState.SetString("QaAgent.FastUi.parameter_file", ${JSON.stringify(this.parameterFile)});
return new { input_sent = false };`;
    const r=await this.session.batch([exec(setup),exec(this.parameterCode),exec(this.inputCode),exec(this.snapshotCode)]);
    if(!r.slice(1).every(x=>x?.status==='compiled_only'&&x.input_sent===false))throw Error('Unsafe preparation outcome');
    this.prepared=true;
    return {compiled:3,input_sent:false};
  }
  async snapshot() { return (await this.session.batch([exec(this.snapshotCode)]))[0]; }
  async click(id,{fraction=0.5,expect=()=>true,label=id,validate=()=>{}}={}) {
    if(!this.prepared||!this.session.active)throw Error('Prepare and begin before UI input');
    const target=TARGETS[id];
    if(!target)throw Error('Unapproved settings control: '+id);
    if(!Number.isFinite(fraction)||fraction<0||fraction>1)throw Error('Invalid slider fraction');
    if(this.session.errorAlert)throw Error('UI stopped on a new error');
    for(let attempt=0;attempt<12;attempt++) {
      const before=await this.snapshot();validate(before);
      await writeFile(this.parameterFile,target+'\n'+fraction.toFixed(9),'utf8');
      const [selected,ack,first]=await this.session.batch([exec(this.parameterCode),exec(this.inputCode),exec(this.snapshotCode)]);
      if(selected?.status!=='selected')throw Error('Target parameters not selected');
      let state=first;
      const ackDeadline=performance.now()+800;
      while(ack?.status==='pending'&&state?.status==='pending'&&performance.now()<ackDeadline) {
        await sleep(15);state=await this.snapshot();
      }
      const status=ack?.status==='pending'?state?.status:ack?.status;
      this.onEvent({id,label,status,attempt,state});
      if(['not_sent_covered','not_sent_blocked'].includes(status)) { await sleep(25);continue; }
      if(status!=='sent')throw new SettingsOutcomeError('Input outcome unknown; no replay: '+status,state);
      const deadline=performance.now()+2200;
      while(true) {
        validate(state);
        if(expect(state))return state;
        if(performance.now()>=deadline)throw new SettingsOutcomeError('Expected UI outcome not observed: '+label,state);
        await sleep(20);state=await this.snapshot();
      }
    }
    throw new SettingsOutcomeError('Known target remained blocked/covered',await this.snapshot());
  }
}
