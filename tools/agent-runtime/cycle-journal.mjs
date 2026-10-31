// One ordered local event stream. Appending telemetry never waits on the Unity path.
import {mkdir,appendFile,writeFile,rename} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export class CycleJournal {
  constructor({write=async()=>{},now=()=>performance.now(),maxEvents=30000}={}) {
    this.write=write;this.now=now;this.started=now();this.maxEvents=maxEvents;
    this.events=[];this.tail=Promise.resolve();this.failure=null;this.closed=false;this.listeners=new Set();
  }
  onFailure(listener){this.listeners.add(listener);if(this.failure)listener(this.failure);return()=>this.listeners.delete(listener);}
  fail(error){
    if(this.failure)return;
    this.failure=error;
    for(const listener of this.listeners)try{listener(error);}catch{}
  }
  record(type,fields={}){
    if(this.closed||this.failure)return null;
    if(this.events.length>=this.maxEvents){this.fail(Error('Cycle telemetry limit exceeded'));return null;}
    let event;
    try{event=freeze(structuredClone({...fields,type,seq:this.events.length+1,ms:this.now()-this.started}));}
    catch(error){this.fail(error);return null;}
    this.events.push(event);
    this.tail=this.tail.then(()=>{if(!this.failure)return this.write(event);}).catch(error=>this.fail(error));
    return event;
  }
  async flush(){await this.tail;if(this.failure)throw this.failure;}
  async close(){this.closed=true;Object.freeze(this.events);await this.flush();}
}

export async function createCycleArtifacts({directory,cycleId,write=writeFile}){
  if(!isAbsolute(directory)||!/^[a-zA-Z0-9_-]{1,100}$/.test(cycleId))throw Error('Local artifact directory and safe cycle ID required');
  const folder=join(directory,'cycles',cycleId);
  await mkdir(join(directory,'cycles'),{recursive:true});
  await mkdir(folder); // Never reuse an earlier attempt directory.
  const eventsPath=join(folder,'events.ndjson');
  await writeFile(eventsPath,'',{flag:'wx'}); // Never overwrite an earlier attempt.
  const journal=new CycleJournal({write:event=>appendFile(eventsPath,JSON.stringify(event)+'\n','utf8')});
  let saving=false;
  return{journal,folder,
    async save(report,analysis){
      if(saving)throw Error('Cycle finalization was already attempted');saving=true;
      await write(join(folder,'analysis.json'),JSON.stringify(analysis,null,2)+'\n','utf8');
      await write(join(folder,'knowledge-candidates.json'),JSON.stringify({
        schema:'ocean-learning-inbox/1',status:'PROPOSED',active_knowledge_changed:false,candidates:analysis.candidates
      },null,2)+'\n','utf8');
      await write(join(folder,'report.json.pending'),JSON.stringify({...report,evidence_path:folder},null,2)+'\n','utf8');
      await rename(join(folder,'report.json.pending'),join(folder,'report.json'));
      return folder;
    }
  };
}
