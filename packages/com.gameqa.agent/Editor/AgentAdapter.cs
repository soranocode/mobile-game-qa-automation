using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;

namespace GameQA.Agent
{
    [InitializeOnLoad]
    public static class AgentAdapter
    {
        public const string Version = "0.1.0";
        private const string Prefix = "QaAgent.FastUi.";
        private static string epoch = Guid.NewGuid().ToString("N"), token, owner;
        private static string sessionEpoch;
        private static long errors, baseline;
        private static double touched;
        private static bool previousBackground;
        private static JobEngine engine;
        private static Coroutine coroutine;
        private static EventSystem driver;

        static AgentAdapter()
        {
            Application.logMessageReceivedThreaded += OnLog;
            EditorApplication.update += Watchdog;
            EditorApplication.playModeStateChanged += _ => Invalidate("play_changed");
            EditorSceneManager.sceneOpened += (s, m) => Invalidate("scene_changed");
            SceneManager.sceneLoaded += (s, m) => Invalidate("scene_changed");
            SceneManager.sceneUnloaded += s => Invalidate("scene_changed");
            SceneManager.activeSceneChanged += (before, after) => Invalidate("scene_changed");
            AssemblyReloadEvents.beforeAssemblyReload += () => Invalidate("domain_reload");
            EditorApplication.quitting += () => Invalidate("editor_quitting");
        }

        private static void OnLog(string text, string stack, LogType type)
        {
            if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert) Interlocked.Increment(ref errors);
        }
        private static bool LegacyBusy { get { return SessionState.GetBool(Prefix + "active", false) || SessionState.GetBool(Prefix + "cycle_active", false); } }
        private static string Interruption()
        {
            if (token == null || sessionEpoch != epoch) return "stale_session";
            if (SessionState.GetString(Prefix + "cycle_owner", "") != "gameqa:" + token ||
                !SessionState.GetBool(Prefix + "active", false) || !SessionState.GetBool(Prefix + "cycle_active", false)) return "owner_lost";
            if (!EditorApplication.isPlaying) return "play_stopped";
            if (EditorApplication.isPaused) return "editor_paused";
            if (EditorApplication.isCompiling) return "compiling";
            if (Interlocked.Read(ref errors) != baseline) return "new_console_error";
            if (driver == null || !driver.isActiveAndEnabled || EventSystem.current != driver) return "input_driver_changed";
            return null;
        }
        internal static void Guard()
        {
            var reason = Interruption();
            if (reason != null) throw new InvalidOperationException(reason);
        }
        private static void Watchdog()
        {
            if (token == null) return;
            engine.Pump(false);
            var reason = Interruption();
            if (reason != null || EditorApplication.timeSinceStartup - touched > 90)
            {
                Close(reason ?? "session_expired"); return;
            }
            if (engine.Busy) { EditorApplication.QueuePlayerLoopUpdate(); }
        }
        private static IEnumerator Frames()
        {
            while (token != null)
            {
                yield return new WaitForEndOfFrame();
                if (token != null) engine.Pump(true);
            }
        }
        private static void Invalidate(string reason)
        {
            Close(reason); epoch = Guid.NewGuid().ToString("N");
        }
        private static void Close(string reason)
        {
            if (token == null) return;
            engine.Stop(reason);
            if (driver != null && coroutine != null) driver.StopCoroutine(coroutine);
            if (SessionState.GetString(Prefix + "cycle_owner", "") == "gameqa:" + token)
            {
                SessionState.SetBool(Prefix + "active", false);
                SessionState.SetBool(Prefix + "cycle_active", false);
                SessionState.SetString(Prefix + "cycle_owner", "");
                Application.runInBackground = previousBackground;
            }
            // Keep terminal reports in engine until the next explicit open; old tokens still cannot run.
            lastToken = token; lastEpoch = sessionEpoch;
            token = null; owner = null; coroutine = null; driver = null;
        }
        private static string lastToken, lastEpoch;

        private static void Authenticate(JObject request, bool terminalRead = false)
        {
            var supplied = (string)request["token"];
            var suppliedEpoch = (string)request["epoch"];
            if (token != null && supplied == token && suppliedEpoch == sessionEpoch) { touched = EditorApplication.timeSinceStartup; return; }
            if (terminalRead && token == null && supplied != null && supplied == lastToken && suppliedEpoch == lastEpoch) return;
            throw new InvalidOperationException("stale_or_foreign_session");
        }

        public static object Handle(JObject request)
        {
            if (request == null) throw new ArgumentException("request_required");
            var action = (string)request["action"];
            if (action == "capabilities") return new { version = Version, epoch, editor_only = true,
                steps = new[] { "ui.click", "ocean.hook" }, max_steps = 16, max_requests = 64,
                gameplay_verified = false, transport = "existing_unity_mcp" };
            if (action == "observe")
            {
                var selector = request["selector"] as JObject;
                var matches = selector == null ? new GameObject[0] : UiInput.Find(selector);
                return new { version = Version, epoch, play = EditorApplication.isPlaying, paused = EditorApplication.isPaused,
                    session_owned = token != null, busy = engine != null && engine.Busy,
                    scenes = Enumerable.Range(0, SceneManager.sceneCount).Select(i => SceneManager.GetSceneAt(i).path).ToArray(),
                    ui_match_count = matches.Length, ui_truncated = matches.Length > 32,
                    ui = matches.Take(32).Select(go => new { id = go.GetInstanceID(), path = UiInput.Path(go) }).ToArray(),
                    world = (bool?)request["world"] == true ? OceanHook.Observe() : null };
            }
            if (action == "open")
            {
                if (token != null || LegacyBusy) throw new InvalidOperationException("runtime_owned");
                if (!EditorApplication.isPlaying || EditorApplication.isPaused || EditorApplication.isCompiling) throw new InvalidOperationException("editor_not_ready");
                owner = (string)request["owner"];
                if (string.IsNullOrWhiteSpace(owner) || owner.Length > 100) throw new ArgumentException("owner_required");
                driver = EventSystem.current;
                if (driver == null || !driver.isActiveAndEnabled) throw new InvalidOperationException("event_system_missing");
                token = Guid.NewGuid().ToString("N"); sessionEpoch = epoch; baseline = Interlocked.Read(ref errors);
                touched = EditorApplication.timeSinceStartup; previousBackground = Application.runInBackground;
                SessionState.SetBool(Prefix + "active", true);
                SessionState.SetBool(Prefix + "cycle_active", true);
                SessionState.SetString(Prefix + "cycle_owner", "gameqa:" + token);
                Application.runInBackground = true;
                engine = new JobEngine(() => EditorApplication.timeSinceStartup, Interruption);
                try { coroutine = driver.StartCoroutine(Frames()); }
                catch { Close("session_start_failed"); throw; }
                return new { token, epoch = sessionEpoch, owner, version = Version };
            }
            Authenticate(request, action == "status" || action == "close" || action == "cancel");
            if (action == "status") { engine.Pump(false); return engine.Get((string)request["request_id"]); }
            if (action == "cancel") { Close("user_cancelled"); return new { cancelled = true, session_closed = true }; }
            if (action == "close") { Close("session_closed"); return new { closed = true }; }
            if (action != "run") throw new ArgumentException("unknown_action");
            var steps = request["steps"] as JArray;
            if (steps == null || steps.Count == 0 || steps.Count > 16) throw new ArgumentException("invalid_steps");
            var factories = new List<Func<IOperation>>();
            foreach (var item in steps)
            {
                var spec = (item as JObject)?.DeepClone() as JObject;
                if (spec == null) throw new ArgumentException("step_object_required");
                var kind = (string)spec["kind"];
                if (kind == "ui.click")
                {
                    ValidateSelector(spec["selector"] as JObject);
                    if (spec["expect"] != null)
                    {
                        var expect = spec["expect"] as JObject;
                        if (expect == null || expect["present"] == null || expect["present"].Type != JTokenType.Boolean) throw new ArgumentException("invalid_expectation");
                        ValidateSelector(expect["selector"] as JObject);
                    }
                    var wait = (double?)spec["wait_seconds"] ?? 3;
                    if (double.IsNaN(wait) || double.IsInfinity(wait) || wait < 0 || wait > 10) throw new ArgumentException("invalid_wait");
                    factories.Add(() => new UiClick(spec));
                }
                else if (kind == "ocean.hook")
                {
                    if (steps.Count != 1 || spec["target_id"] == null || spec["target_id"].Type != JTokenType.Integer) throw new ArgumentException("hook_requires_single_target_step");
                    factories.Add(() => new OceanHook((int)spec["target_id"]));
                }
                else throw new ArgumentException("unsupported_step");
            }
            // Canonical body includes semantic step parameters and the deadline; no mutable caller objects retained.
            var timeout = (double?)request["timeout_seconds"] ?? 15;
            var fingerprint = steps.ToString(Newtonsoft.Json.Formatting.None) + ":" + timeout.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            var result = engine.Start((string)request["request_id"], fingerprint, factories, timeout);
            var gameView = Resources.FindObjectsOfTypeAll<EditorWindow>().FirstOrDefault(w => w.GetType().Name == "GameView");
            if (gameView != null) { gameView.Focus(); gameView.Repaint(); }
            EditorApplication.QueuePlayerLoopUpdate();
            return result;
        }
        private static void ValidateSelector(JObject selector)
        {
            if (selector == null || !new[] { "path", "name", "component" }.Any(k => selector[k]?.Type == JTokenType.String && !string.IsNullOrWhiteSpace((string)selector[k])))
                throw new ArgumentException("invalid_selector");
            foreach (var property in selector.Properties())
                if (!new[] { "path", "name", "component", "ancestor" }.Contains(property.Name) || property.Value.Type != JTokenType.String || ((string)property.Value).Length > 500)
                    throw new ArgumentException("invalid_selector_field");
        }
    }
}
