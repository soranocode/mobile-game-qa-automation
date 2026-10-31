// Dependency-injected client. Importing never connects to Unity or starts a job.
export class AdapterOutcomeUnknown extends Error {
  constructor(action, requestId, cause) {
    super(`Adapter ${action} response unknown; reconcile status before any new input`, {cause});
    this.action = action;
    this.requestId = requestId;
  }
}

export class UnityAgentAdapter {
  #invoke;
  #session = null;
  #pending = null;
  #seen = new Set();
  #inputDisabled = false;
  #opening = false;
  constructor(invoke) { this.#invoke = invoke; }
  async #call(parameters) {
    let result;
    try { result = await this.#invoke('execute_custom_tool', {tool_name: 'gameqa', parameters}); }
    catch (cause) { throw new AdapterOutcomeUnknown(parameters.action, parameters.request_id, cause); }
    if (result?.structuredContent) result = result.structuredContent;
    if (!('success' in (result ?? {}))) {
      const text = result?.content?.find(item => item.type === 'text')?.text;
      try { result = JSON.parse(text); }
      catch (cause) { throw new AdapterOutcomeUnknown(parameters.action, parameters.request_id, cause); }
    }
    if (!result?.success) throw new Error(result?.error ?? result?.code ?? 'Adapter rejected request');
    return result.data;
  }
  capabilities() { return this.#call({action:'capabilities'}); }
  observe(options = {}) { return this.#call({...options, action:'observe'}); }
  async open(owner) {
    if (this.#session || this.#opening) throw Error('Client already owns or is opening a session');
    this.#opening = true;
    try {
      const session = await this.#call({action:'open', owner});
      if (!session?.token || !session?.epoch) throw Error('Invalid adapter session');
      this.#session = {token:session.token, epoch:session.epoch};
      this.#seen.clear(); this.#inputDisabled = false;
      return session;
    } finally { this.#opening = false; }
  }
  async run({requestId, steps, timeoutSeconds = 15}) {
    if (!this.#session) throw Error('Open a session first');
    if (this.#inputDisabled) throw Error('Session input stopped; only reconcile status');
    if (this.#pending) throw Error('Reconcile the previous job before starting another');
    if (!requestId || this.#seen.has(requestId)) throw Error('Use a new explicit request ID; never replay from this client');
    this.#seen.add(requestId); this.#pending = requestId;
    // Keep pending on every failure. A transport/rejection response does not prove no input was sent.
    const result = await this.#call({...this.#session, action:'run', request_id:requestId, steps, timeout_seconds:timeoutSeconds});
    if (result?.status && result.status !== 'running') this.#pending = null;
    return result;
  }
  async status(requestId = this.#pending) {
    if (!this.#session || !requestId) throw Error('Session and request ID required');
    const result = await this.#call({...this.#session, action:'status', request_id:requestId});
    if (requestId === this.#pending && result?.status && result.status !== 'running') this.#pending = null;
    return result;
  }
  async cancel() {
    if (!this.#session) return {cancelled:false};
    this.#inputDisabled = true;
    const result = await this.#call({...this.#session, action:'cancel'});
    // Preserve credentials for one final status read; server invalidates them for input.
    return result;
  }
  async close() {
    if (!this.#session) return {closed:false};
    this.#inputDisabled = true;
    const result = await this.#call({...this.#session, action:'close'});
    this.#session = null; this.#pending = null;
    return result;
  }
}
