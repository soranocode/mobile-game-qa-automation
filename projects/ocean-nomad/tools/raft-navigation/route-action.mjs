import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const KEY='QaAgent.RaftRoute.v1';
const exec=code=>({tool:'execute_code',params:{action:'execute',code,safety_checks:true}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const READ=`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;return d==null?(object)new{status="idle"}:d["result"];`;
const STOP=`var d=System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;if(d!=null&&!(bool)d["finished"])((System.Action)d["cancel"])();return d==null?(object)new{status="idle"}:d["result"];`;

export function validateRoute(route,{analog=.85,seconds=25}={}) {
  if(route?.status!=='PLANNED_NOT_EXECUTED'||!Number.isSafeInteger(route.scene_handle)||
     !Number.isFinite(route.deck_y)||!Number.isFinite(analog)||analog<=0||analog>1||
     !Number.isFinite(seconds)||seconds<=0||seconds>45||
     !/^[a-f0-9]{64}$/.test(route.geometry_sha256??''))throw new Error('A fresh planned route and bounded input settings are required');
  for(const [rows,width,max] of [[route.points_xz,2,256],[route.safe_rectangles,4,512],[route.floor_bounds,7,512]])
    if(!Array.isArray(rows)||!rows.length||rows.length>max||rows.some(r=>!Array.isArray(r)||r.length!==width||r.some(v=>!Number.isFinite(v))))throw new Error('Invalid route geometry');
  if(route.points_xz.length<2||!Array.isArray(route.floor_ids)||!route.floor_ids.length||
     route.floor_ids.some(id=>!Number.isSafeInteger(id))||new Set(route.floor_ids).size!==route.floor_ids.length||
     route.floor_bounds.length!==route.floor_ids.length||route.floor_bounds.some(b=>!route.floor_ids.includes(b[0])))throw new Error('Invalid floor bindings');
  return [route.scene_handle,route.deck_y,seconds,analog,.06,3.2,
    route.points_xz.map(p=>p.join(',')).join(';'),route.safe_rectangles.map(r=>r.join(',')).join(';'),
    route.floor_ids.join(','),route.geometry_sha256,route.floor_bounds.map(r=>r.join(',')).join(';')].join('\n');
}

// One ordinary UI gesture, steered locally against live observations. No local task selection.
export class RaftRouteAction {
  constructor(session,{source,parameterFile}) {
    this.session=session;this.code=session.instrument(source);this.parameterFile=parameterFile;this.running=false;
  }
  async stop(){return (await this.session.batch([exec(STOP)],{checkErrors:false}))[0];}
  async run(route,options={}) {
    if(!this.session.active||this.running)throw new Error('A single active Unity session is required');
    const protocol=validateRoute(route,options);
    const request=randomUUID(),started=performance.now();this.running=true;
    try {
      await writeFile(this.parameterFile,protocol);
      const [,ack]=await this.session.batch([
        exec(`UnityEditor.SessionState.SetString("${KEY}.params",${JSON.stringify(this.parameterFile)});UnityEditor.SessionState.SetString("${KEY}.request",${JSON.stringify(request)});UnityEditor.SessionState.SetString("${KEY}.mode","run");return new{input_sent=false};`),exec(this.code)]);
      if(ack?.status!=='running')return {...ack,input_sent:false,request,host_ms:performance.now()-started};
      if(ack.request!==request)throw new Error('Input acknowledgement belongs to another request');
      const deadline=performance.now()+(options.seconds??25)*1000+2500;
      while(performance.now()<deadline){
        await pause(350);
        const result=(await this.session.batch([exec(READ)]))[0];
        if(result?.request!==request)throw new Error('Stale route result; never treat earlier completion as this run');
        if(result.status!=='running')return {...result,host_ms:performance.now()-started};
      }
      return {status:'host_timeout',request,cleanup:await this.stop(),host_ms:performance.now()-started};
    } catch(error){try{await this.stop();}catch{}throw error;}
    finally{this.running=false;}
  }
}
