#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

namespace QaDemonstrations
{
    public static class DemoCapture
    {
        public const string Schema = "ocean-demo/1";
        public static string Profile { get { return DemoObservation.ProfileId; } }
        private static readonly KeyCode[] Keys = {
            KeyCode.W, KeyCode.A, KeyCode.S, KeyCode.D,
            KeyCode.UpArrow, KeyCode.DownArrow, KeyCode.LeftArrow, KeyCode.RightArrow,
            KeyCode.Space, KeyCode.LeftShift, KeyCode.RightShift, KeyCode.LeftControl,
            KeyCode.RightControl, KeyCode.LeftAlt, KeyCode.RightAlt, KeyCode.Escape, KeyCode.F8
        };
        private static readonly string[] Axes = { "Horizontal", "Vertical", "Jump", "Mouse X", "Mouse Y" };
        private static JournalWriter writer;
        private static System.Diagnostics.Stopwatch clock;
        private static GameObject host;
        private static string sessionId;
        private static string startedUtc;
        private static string gap;
        private static long seq;
        private static int markerId;
        private static string lastInputSignature;
        private static double lastInputMs;
        private static double lastStateMs;
        private static Vector3 lastMouse;
        private static bool mouseKnown;
        private static bool groundedKnown;
        private static bool lastGrounded;
        private static bool stateCheckpoint;
        private static JObject metadata;
        private static GUIStyle overlayStyle;
        public static bool IsRecording { get; private set; }
        public static string LastFolder { get; private set; }
        public static string LastError { get; private set; }
        public static bool ShowOverlay { get; set; } = true;
        public static int InputEvents { get; private set; }
        public static int StateEvents { get; private set; }
        public static event Action<string> BeforeStop;
        public static event Action SessionStarted;
        public static event Action StateSampled;
        private static int mainThreadId;
        private static bool stopping;
        private static double previousUpdateMs, sumUpdateMs, worstUpdateMs, fpsWindowMs;
        private static long updateIntervals;
        private static int fpsWindowFrames;
        public static double UpdateFps { get; private set; }
        public static double ElapsedMs { get { return clock == null ? 0 : clock.Elapsed.TotalMilliseconds; } }

        public static string Start(string outputRoot, string label)
        {
            if (IsRecording) throw new InvalidOperationException("Already recording");
            if (!EditorApplication.isPlaying || EditorApplication.isPaused || EditorApplication.isCompiling)
                throw new InvalidOperationException("Enter Play and unpause before recording; recorder never starts gameplay");
            if (string.IsNullOrWhiteSpace(outputRoot)) throw new ArgumentException("Output folder is required");
            if (label != null && label.Length > 240) throw new ArgumentException("Label must be at most 240 characters");
            DemoObservation.SelectForSession();
            mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
            LastError = null;
            sessionId = Guid.NewGuid().ToString("N");
            startedUtc = DateTime.UtcNow.ToString("o");
            LastFolder = Path.Combine(Path.GetFullPath(outputRoot), DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ") + "-" + sessionId.Substring(0, 8));
            Directory.CreateDirectory(LastFolder);
            metadata = JObject.FromObject(new {
                schema = Schema, session_id = sessionId, start_utc = startedUtc, profile_id = Profile,
                game_version = Application.version, unity_version = Application.unityVersion,
                package_id = RecorderPackage.Name, package_version = RecorderPackage.Version,
                label = label ?? "", runtime = "UnityEditor", input_precision = "Unity frame-observed; not OS timestamps",
                input_sampling = "early Update each frame; edges/changes/motion or 100ms heartbeat",
                state_sampling = "late LateUpdate up to 10Hz plus grounded transitions and marker checkpoints", coordinate_units = "unity_units",
                space_jump_binding = DemoObservation.SpaceJumpBinding,
                video_recorded = false, overlay_enabled = ShowOverlay, complete = false,
                finalized = false, max_duration_ms = 30 * 60 * 1000, max_queue_bytes = 4 * 1024 * 1024
            });
            File.WriteAllText(Path.Combine(LastFolder, "session.json"), metadata.ToString(Formatting.Indented));
            seq = 0; markerId = 0; InputEvents = 0; StateEvents = 0;
            gap = null; lastInputSignature = null; lastInputMs = -1000; lastStateMs = -1000; mouseKnown = false; groundedKnown = false;
            clock = System.Diagnostics.Stopwatch.StartNew();
            previousUpdateMs = -1; sumUpdateMs = 0; worstUpdateMs = 0; updateIntervals = 0;
            fpsWindowMs = 0; fpsWindowFrames = 0; UpdateFps = 0;
            writer = new JournalWriter(Path.Combine(LastFolder, "events.ndjson"));
            IsRecording = true;
            try
            {
                host = new GameObject("QA demonstration recorder (observation only)");
                host.hideFlags = HideFlags.DontSave;
                Object.DontDestroyOnLoad(host);
                host.AddComponent<DemoEarlySampler>();
                host.AddComponent<DemoLateSampler>();
                SceneManager.sceneLoaded += OnSceneLoaded;
                SceneManager.sceneUnloaded += OnSceneUnloaded;
                Application.focusChanged += OnFocus;
                Application.quitting += OnQuit;
                Emit("session_start", new { profile_id = Profile, start_utc = startedUtc });
                Mark("session_sync_start");
                InvokeExtensions(SessionStarted, "session_started");
            }
            catch (Exception error) { LastError = "Start failed: " + error.GetType().Name; Stop("start_fault"); throw; }
            return LastFolder;
        }

        public static JObject Status()
        {
            return JObject.FromObject(new { recording = IsRecording, folder = LastFolder, error = LastError,
                elapsed_ms = ElapsedMs, input_events = InputEvents, state_events = StateEvents,
                events_accepted = writer == null ? 0 : writer.Accepted,
                events_written = writer == null ? 0 : writer.Written, gap_reason = gap,
                gameplay_control = false, package_id = RecorderPackage.Name, package_version = RecorderPackage.Version,
                profile_id = Profile, video_recorded = metadata != null && (bool?)metadata["video_recorded"] == true });
        }

        public static void SetVideoStatus(bool fileWritten, object status)
        {
            if (!IsRecording) return;
            metadata["video_recorded"] = fileWritten;
            metadata["video"] = JToken.FromObject(status);
            Emit("video", status);
        }

        public static void Stop(string reason = "user_stop")
        {
            if (!IsRecording || stopping) return;
            stopping = true;
            // The Editor video adapter must finalize before the journal is closed.
            // A failed subscriber must not prevent flushing the input log.
            if (BeforeStop != null)
                foreach (Action<string> handler in BeforeStop.GetInvocationList())
                    try { handler(reason); }
                    catch (Exception error) { RecordExtensionFault("before_stop", error); }
            Emit("session_end", new { reason = reason, input_events = InputEvents, state_events = StateEvents,
                writer_status = "pending_flush" });
            IsRecording = false;
            SceneManager.sceneLoaded -= OnSceneLoaded;
            SceneManager.sceneUnloaded -= OnSceneUnloaded;
            Application.focusChanged -= OnFocus;
            Application.quitting -= OnQuit;
            bool drained = writer.Finish();
            if (!drained) LastError = writer.Error ?? "Writer did not finish within 3 seconds; incomplete journal";
            bool complete = drained && LastError == null;
            clock.Stop();
            metadata["end_utc"] = DateTime.UtcNow.ToString("o");
            metadata["elapsed_ms"] = ElapsedMs;
            metadata["end_reason"] = reason;
            metadata["input_events"] = InputEvents;
            metadata["state_events"] = StateEvents;
            metadata["update_timing"] = JObject.FromObject(new { intervals = updateIntervals,
                mean_update_fps = sumUpdateMs > 0 ? updateIntervals * 1000.0 / sumUpdateMs : 0,
                worst_update_gap_ms = worstUpdateMs,
                note = "Observed early Update cadence including stalls; not GPU timing or an unrecorded baseline" });
            metadata["events_accepted"] = writer.Accepted;
            metadata["events_written"] = writer.Written;
            metadata["writer_error"] = LastError;
            metadata["complete"] = complete;
            metadata["finalized"] = true;
            try { File.WriteAllText(Path.Combine(LastFolder, "session.json"), metadata.ToString(Formatting.Indented)); }
            catch (Exception error) { LastError = "Metadata finalize failed: " + error.Message; }
            if (host != null) Object.Destroy(host);
            host = null;
            stopping = false;
        }

        public static void Mark(string label)
        {
            if (!IsRecording) return;
            stateCheckpoint = true;
            Emit("marker", new { label = (label ?? "").Substring(0, Math.Min(240, (label ?? "").Length)), marker_id = ++markerId });
        }

        // Opt-in telemetry modules share the recorder's clock/frame and journal.
        // Call on the Unity main thread, emit changes rather than per-frame inventory dumps.
        public static bool RecordModuleEvent(string moduleId, string eventName, object payload)
        {
            if (!IsRecording) return false;
            if (System.Threading.Thread.CurrentThread.ManagedThreadId != mainThreadId)
                throw new InvalidOperationException("Module events require the Unity main thread");
            const string token = @"\A[a-zA-Z0-9_.-]{1,80}\z";
            if (moduleId == null || !System.Text.RegularExpressions.Regex.IsMatch(moduleId, token) ||
                eventName == null || !System.Text.RegularExpressions.Regex.IsMatch(eventName, token))
                throw new ArgumentException("Module ID and event name must be bounded identifiers");
            Emit("module", new { module_id = moduleId, event_name = eventName, payload = payload });
            return LastError == null;
        }

        private static void InvokeExtensions(Action handlers, string phase)
        {
            if (handlers == null) return;
            foreach (Action handler in handlers.GetInvocationList())
                try { handler(); }
                catch (Exception error) { RecordExtensionFault(phase, error); }
        }

        private static void RecordExtensionFault(string phase, Exception error)
        {
            var fault = new { phase = phase, error_type = error.GetType().Name };
            var faults = metadata["extension_errors"] as JArray;
            if (faults == null) { faults = new JArray(); metadata["extension_errors"] = faults; }
            // Bound repeated faults; no exception messages, private game values or stack traces.
            if (faults.Count < 32) { faults.Add(JToken.FromObject(fault)); Emit("module_error", fault); }
        }

        public static void EditorTick()
        {
            if (!IsRecording) return;
            if (host == null) { LastError = "Recorder host removed"; Stop("host_removed"); return; }
            if (writer.Error != null) { LastError = writer.Error; Stop("writer_fault"); return; }
            if (ElapsedMs > 30 * 60 * 1000) { Stop("duration_limit"); return; }
            if (EditorApplication.isPaused) ChangeGap("editor_paused");
            else if (!Application.isFocused) ChangeGap("focus_lost");
            else if (!GameViewFocused()) ChangeGap("game_view_not_focused");
        }

        internal static void CaptureInput()
        {
            if (!IsRecording) return;
            double updateMs = ElapsedMs;
            if (previousUpdateMs >= 0) { double dt = updateMs - previousUpdateMs; sumUpdateMs += dt; updateIntervals++; worstUpdateMs = Math.Max(worstUpdateMs, dt); }
            previousUpdateMs = updateMs;
            fpsWindowFrames++;
            if (updateMs - fpsWindowMs >= 1000) { UpdateFps = fpsWindowFrames * 1000.0 / (updateMs - fpsWindowMs); fpsWindowFrames = 0; fpsWindowMs = updateMs; }
            try
            {
                string reason = EditorApplication.isPaused ? "editor_paused" : !Application.isFocused ? "focus_lost" :
                    !GameViewFocused() ? "game_view_not_focused" : TextSelected() ? "text_input_selected" : null;
                ChangeGap(reason);
                if (reason != null) { mouseKnown = false; return; }
                var held = new List<string>(); var down = new List<string>(); var up = new List<string>();
                foreach (var key in Keys)
                {
                    if (Input.GetKey(key)) held.Add(key.ToString());
                    if (Input.GetKeyDown(key)) down.Add(key.ToString());
                    if (Input.GetKeyUp(key)) up.Add(key.ToString());
                }
                var mouseHeld = new List<int>(); var mouseDown = new List<int>(); var mouseUp = new List<int>();
                for (int i = 0; i < 3; i++)
                {
                    if (Input.GetMouseButton(i)) mouseHeld.Add(i);
                    if (Input.GetMouseButtonDown(i)) mouseDown.Add(i);
                    if (Input.GetMouseButtonUp(i)) mouseUp.Add(i);
                }
                Vector3 mouse = Input.mousePosition;
                Vector3 delta = mouseKnown ? mouse - lastMouse : Vector3.zero;
                lastMouse = mouse; mouseKnown = true;
                var axes = new Dictionary<string, object>();
                var axisValues = new List<float>();
                foreach (string name in Axes)
                {
                    try
                    {
                        float value = Input.GetAxis(name); float raw = Input.GetAxisRaw(name);
                        axes[name] = new { available = true, value = value, raw = raw }; axisValues.Add(value);
                    }
                    catch { axes[name] = new { available = false }; }
                }
                string signature = string.Join(",", held) + ":" + string.Join(",", mouseHeld) + ":" + string.Join(",", axisValues.Select(v => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture)));
                bool edge = down.Count + up.Count + mouseDown.Count + mouseUp.Count > 0;
                bool motion = delta.sqrMagnitude > 0.001f || Input.mouseScrollDelta.sqrMagnitude > 0.001f;
                if (edge || motion || signature != lastInputSignature || ElapsedMs - lastInputMs >= 100)
                {
                    Emit("input", new { keys_held = held, keys_down = down, keys_up = up,
                        mouse_held = mouseHeld, mouse_down = mouseDown, mouse_up = mouseUp,
                        mouse_position = new[] { mouse.x, mouse.y }, mouse_delta = new[] { delta.x, delta.y },
                        screen_size = new[] { Screen.width, Screen.height },
                        mouse_position_normalized = new[] { mouse.x / Math.Max(1, Screen.width), mouse.y / Math.Max(1, Screen.height) },
                        mouse_scroll = new[] { Input.mouseScrollDelta.x, Input.mouseScrollDelta.y },
                        axes = axes, focused = true, capture_allowed = true, suppressed_reason = (string)null,
                        ui_hit = mouseDown.Count + mouseUp.Count > 0 ? PointerTarget(mouse) : null });
                    InputEvents++; lastInputSignature = signature; lastInputMs = ElapsedMs;
                }
                if (Input.GetKeyDown(KeyCode.F8)) Mark("user_sync");
            }
            catch (Exception error) { LastError = "Input sample failed: " + error.GetType().Name; Stop("sample_fault"); }
        }

        internal static void CaptureState()
        {
            if (!IsRecording || EditorApplication.isPaused) return;
            try
            {
                bool grounded;
                bool known = DemoObservation.TryGrounded(out grounded);
                bool edge = known != groundedKnown || (known && grounded != lastGrounded);
                if (!edge && !stateCheckpoint && ElapsedMs - lastStateMs < 100) return;
                groundedKnown = known; lastGrounded = grounded; stateCheckpoint = false;
                Emit("state", DemoObservation.Read()); StateEvents++; lastStateMs = ElapsedMs;
                InvokeExtensions(StateSampled, "state_sampled");
            }
            catch (Exception error) { LastError = "State sample failed: " + error.GetType().Name; Stop("sample_fault"); }
        }

        internal static void Overlay()
        {
            if (!IsRecording || !ShowOverlay) return;
            if (overlayStyle == null) overlayStyle = new GUIStyle(GUI.skin.label) { fontSize = 15, normal = { textColor = Color.white } };
            GUI.Label(new Rect(12, 12, 690, 45), "QA DEMO  " + (ElapsedMs / 1000).ToString("F2") + " s  frame " + Time.frameCount + "  marker " + markerId + "  F8 = sync", overlayStyle);
        }

        private static void Emit(string kind, object data)
        {
            if (!IsRecording || writer == null) return;
            var record = new { schema = Schema, session_id = sessionId, seq = ++seq, kind = kind,
                frame = Time.frameCount, t_ms = ElapsedMs, utc = DateTime.UtcNow.ToString("o"), data = data };
            if (!writer.Append(JsonConvert.SerializeObject(record))) LastError = writer.Error ?? "Journal write refused";
        }

        private static void ChangeGap(string reason)
        {
            if (reason == gap) return;
            if (gap != null) Emit("gap_end", new { reason = gap });
            gap = reason;
            lastInputSignature = null;
            if (gap != null) Emit("gap_start", new { reason = gap });
        }

        private static bool GameViewFocused()
        {
            return EditorWindow.focusedWindow != null && EditorWindow.focusedWindow.GetType().Name == "GameView";
        }

        private static bool TextSelected()
        {
            var go = EventSystem.current == null ? null : EventSystem.current.currentSelectedGameObject;
            if (go == null) return false;
            foreach (var component in go.GetComponentsInParent<Component>(true))
                if (component != null && (component.GetType().FullName == "UnityEngine.UI.InputField" || component.GetType().FullName == "TMPro.TMP_InputField")) return true;
            return false;
        }

        private static string PointerTarget(Vector3 mouse)
        {
            if (EventSystem.current == null) return null;
            var hits = new List<RaycastResult>();
            EventSystem.current.RaycastAll(new PointerEventData(EventSystem.current) { position = mouse }, hits);
            if (hits.Count == 0 || hits[0].gameObject == null) return null;
            var names = new List<string>();
            for (var tf = hits[0].gameObject.transform; tf != null; tf = tf.parent) names.Insert(0, tf.name);
            return string.Join("/", names);
        }

        private static void OnSceneLoaded(Scene scene, LoadSceneMode mode) { Emit("scene", new { action = "loaded", name = scene.name, path = scene.path, mode = mode.ToString() }); DemoObservation.Invalidate(); }
        private static void OnSceneUnloaded(Scene scene) { Emit("scene", new { action = "unloaded", name = scene.name, path = scene.path }); DemoObservation.Invalidate(); }
        private static void OnFocus(bool focused) { if (!focused) ChangeGap("focus_lost"); }
        private static void OnQuit() { Stop("application_quitting"); }
    }
}
#endif
