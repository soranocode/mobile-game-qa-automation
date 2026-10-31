// Passive, in-memory Unity event listener. Normal snapshots contain counters, not log text.
const KEY = 'QaAgent.ErrorWatch.v1';
export const INSTALL_ERROR_MONITOR = `
const string key = "${KEY}";
var existing = System.AppDomain.CurrentDomain.GetData(key) as System.Collections.Generic.Dictionary<string,object>;
if (existing != null) return new { installed = true, reused = true };
System.Func<System.Collections.Generic.Dictionary<string,object>> factory = () => {
    var state = new System.Collections.Generic.Dictionary<string,object>();
    state["gate"] = new object();
    state["epoch"] = System.Guid.NewGuid().ToString("N");
    state["total"] = 0L; state["unexpected"] = 0L;
    state["baseline_total"] = 0L; state["baseline_unexpected"] = 0L;
    state["armed"] = false; state["phase"] = "idle";
    state["expected"] = new object[0];
    state["entries"] = new System.Collections.Generic.Queue<object>();
    UnityEngine.Application.LogCallback handler = (message, stack, kind) => {
        if (kind != UnityEngine.LogType.Error && kind != UnityEngine.LogType.Exception && kind != UnityEngine.LogType.Assert) return;
        lock (state["gate"]) {
            bool expected = false;
            string matchedReason = null;
            var phase = (string)state["phase"];
            if ((bool)state["armed"]) foreach (var raw in (object[])state["expected"]) {
                var rule = (System.Collections.Generic.Dictionary<string,object>)raw;
                string contains = (string)rule["contains"];
                string forPhase = (string)rule["phase"];
                if (!string.IsNullOrEmpty(contains) && (string.IsNullOrEmpty(forPhase) || phase == forPhase) &&
                    (message ?? "").Contains(contains)) {
                    expected = true; matchedReason = (string)rule["reason"]; break;
                }
            }
            long seq = (long)state["total"] + 1;
            state["total"] = seq;
            if (!expected) state["unexpected"] = (long)state["unexpected"] + 1;
            var entry = new System.Collections.Generic.Dictionary<string,object>();
            entry["sequence"] = seq; entry["utc"] = System.DateTime.UtcNow.ToString("o");
            entry["type"] = kind.ToString(); entry["phase"] = phase;
            entry["expected"] = expected; entry["expected_reason"] = matchedReason;
            entry["message"] = (message ?? "").Substring(0, System.Math.Min((message ?? "").Length,2048));
            entry["stack"] = (stack ?? "").Substring(0, System.Math.Min((stack ?? "").Length,6000));
            var entries = (System.Collections.Generic.Queue<object>)state["entries"];
            if (entries.Count >= 64) entries.Dequeue();
            entries.Enqueue(entry);
        }
    };
    state["handler"] = handler;
    return state;
};
var created = factory();
created["factory"] = factory;
UnityEngine.Application.logMessageReceivedThreaded += (UnityEngine.Application.LogCallback)created["handler"];
System.AppDomain.CurrentDomain.SetData(key,created);
return new { installed = true, reused = false };
`;

// Shared in-memory guard, evaluated by UI snippets before sending any input.
export const ERROR_WATCH_SNAPSHOT = `
System.Func<object> errorWatchSnapshot = () => {
    var watch = System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
    if (watch == null) return new { available = false };
    lock (watch["gate"]) return (object)new {
        available = true, epoch = (string)watch["epoch"], armed = (bool)watch["armed"],
        new_errors = (long)watch["total"] - (long)watch["baseline_total"],
        unexpected_new_errors = (long)watch["unexpected"] - (long)watch["baseline_unexpected"],
        blocked = (bool)watch["armed"] && (long)watch["unexpected"] > (long)watch["baseline_unexpected"]
    };
};
System.Func<bool> errorWatchBlocked = () => {
    var watch = System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
    if (watch == null) return true;
    lock (watch["gate"]) return !(bool)watch["armed"] ||
        (long)watch["unexpected"] > (long)watch["baseline_unexpected"];
};
`;

export class NewUnityError extends Error {
  constructor(alert) {
    super(alert?.available === false ? 'Unity error watcher unavailable; input stopped' : 'New unexpected Unity error; input stopped');
    this.code = 'UNITY_NEW_ERROR';
    this.alert = alert;
  }
}

export function validateExpectedErrors(rules) {
  if (!Array.isArray(rules) || rules.length > 20) throw new Error('Expected errors must be a bounded array');
  return rules.map(rule => {
    if (typeof rule?.contains !== 'string' || !rule.contains.trim() || rule.contains.length > 500 ||
        typeof rule.reason !== 'string' || !rule.reason.trim() || rule.reason.length > 500 ||
        (rule.phase !== undefined && typeof rule.phase !== 'string'))
      throw new Error('An expected error needs an explicit literal match and human-provided reason');
    return { contains: rule.contains, reason: rule.reason, phase: rule.phase ?? '' };
  });
}

export function armErrorMonitorCode(rules = []) {
  const validated = validateExpectedErrors(rules);
  const literals = validated.map(r => `new System.Collections.Generic.Dictionary<string,object> {
    {"contains",${JSON.stringify(r.contains)}},{"reason",${JSON.stringify(r.reason)}},{"phase",${JSON.stringify(r.phase)}} }`);
  return `var watch = System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
if (watch == null) throw new System.InvalidOperationException("Error watcher unavailable");
lock (watch["gate"]) {
    watch["baseline_total"] = (long)watch["total"];
    watch["baseline_unexpected"] = (long)watch["unexpected"];
    watch["expected"] = new object[] {${literals.join(',')}};
    watch["phase"] = "begin"; watch["armed"] = true;
}
return new { armed = true, expected_rules = ${validated.length} };`;
}

export const DISARM_ERROR_MONITOR = `
var watch = System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
if (watch != null) lock (watch["gate"]) {
    watch["armed"] = false; watch["expected"] = new object[0]; watch["phase"] = "idle";
}
return new { disarmed = true };`;

export const ERROR_MONITOR_DETAILS = `
var watch = System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
if (watch == null) return new { available = false };
lock (watch["gate"]) {
    var entries = (System.Collections.Generic.Queue<object>)watch["entries"];
    long baseline = (long)watch["baseline_total"];
    var current = entries.Cast<System.Collections.Generic.Dictionary<string,object>>()
        .Where(e => (long)e["sequence"] > baseline).ToArray();
    var unexpected = current.Where(e => !(bool)e["expected"]).ToArray();
    var selected = (unexpected.Length > 0 ? unexpected : current).Take(8).ToArray();
    return new { available = true, epoch = (string)watch["epoch"], new_errors = (long)watch["total"] - baseline,
        unexpected_new_errors = (long)watch["unexpected"] - (long)watch["baseline_unexpected"],
        details_limited = ((long)watch["total"] - baseline) > selected.Length, entries = selected };
}`;

// Exercise an isolated callback instance: no Debug.LogError, no real Console entries,
// no input and no change to the installed watcher's counters.
export const SELF_TEST_ERROR_MONITOR = `
var installed = System.AppDomain.CurrentDomain.GetData("${KEY}") as System.Collections.Generic.Dictionary<string,object>;
if (installed == null) throw new System.InvalidOperationException("Install the watcher before its self-test");
var factory = (System.Func<System.Collections.Generic.Dictionary<string,object>>)installed["factory"];
var test = factory();
var handler = (UnityEngine.Application.LogCallback)test["handler"];
handler("old synthetic error", "synthetic", UnityEngine.LogType.Error);
test["baseline_total"] = (long)test["total"]; test["baseline_unexpected"] = (long)test["unexpected"];
test["armed"] = true; test["phase"] = "selected_ui";
test["expected"] = new object[] { new System.Collections.Generic.Dictionary<string,object> {
    {"contains","expected synthetic error"},{"reason","self-test only"},{"phase","selected_ui"}} };
handler("normal log", "", UnityEngine.LogType.Log);
handler("warning", "", UnityEngine.LogType.Warning);
bool ordinaryIgnored = (long)test["total"] == 1L;
handler("expected synthetic error", "synthetic", UnityEngine.LogType.Error);
bool expectedDidNotBlock = (long)test["unexpected"] == (long)test["baseline_unexpected"];
handler("unexpected synthetic fault", "synthetic", UnityEngine.LogType.Exception);
bool unexpectedBlocks = (long)test["unexpected"] > (long)test["baseline_unexpected"];
test["phase"] = "other_phase";
handler("expected synthetic error", "synthetic", UnityEngine.LogType.Assert);
bool scopeEnforced = (long)test["unexpected"] - (long)test["baseline_unexpected"] == 2L;
for (int i=0;i<70;i++) handler("bounded synthetic fault", "synthetic", UnityEngine.LogType.Error);
bool bounded = ((System.Collections.Generic.Queue<object>)test["entries"]).Count == 64;
return new { passed = ordinaryIgnored && expectedDidNotBlock && unexpectedBlocks && scopeEnforced && bounded,
    ordinary_logs_ignored = ordinaryIgnored, expected_error_allowed = expectedDidNotBlock,
    unexpected_error_blocks = unexpectedBlocks, expected_phase_enforced = scopeEnforced,
    bounded_buffer = bounded, isolated_callback_only = true, real_console_errors_emitted = 0, input_sent = false };
`;

export class UnityErrorMonitor {
  constructor(invoke) { this.invoke = invoke; }
  async execute(code) {
    const r = await this.invoke('execute_code', { action: 'execute', code, safety_checks: true, compiler: 'auto' });
    if (!r?.success) throw new Error('Unity error monitor operation failed');
    return r.data?.result;
  }
  async install() { return this.execute(INSTALL_ERROR_MONITOR); }
  async details() { return this.execute(ERROR_MONITOR_DETAILS); }
  async selfTest() { return this.execute(SELF_TEST_ERROR_MONITOR); }
}
