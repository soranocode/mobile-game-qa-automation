#if UNITY_EDITOR
using System;
using System.IO;
using System.Collections;
using System.Reflection;
using UnityEditor;
using UnityEditor.Recorder;
using UnityEditor.Recorder.Encoder;
using UnityEditor.Recorder.Input;
using UnityEngine;
using Object = UnityEngine.Object;

namespace QaDemonstrations.Editor
{
    // One owner for both streams. Video failure never silently degrades into an
    // apparently successful combined recording. No game inputs are generated.
    [InitializeOnLoad]
    public static class DemoVideoSession
    {
        private static RecorderController controller;
        private static RecorderControllerSettings settings;
        private static MovieRecorderSettings movie;
        private static bool starting;
        private static bool ownsVideo;
        private static double startCallMs;
        private static double startedMs;
        private static int startFrame;
        private static bool light;
        private static bool reduceGraphics;
        private static bool overridesApplied;
        private static int oldQuality, oldTargetFps, oldVsync, oldWidth, oldHeight, oldSizeIndex;
        private static EditorWindow gameView;
        private static PropertyInfo sizeIndexProperty;
        private static int videoWidth, videoHeight, submittedFrames;
        private static UnityEditor.Recorder.Recorder recorderObject;
        private static double lastMonitorMs;
        private static readonly PropertyInfo CountProperty = typeof(UnityEditor.Recorder.Recorder).GetProperty("RecordedFramesCount", BindingFlags.Instance | BindingFlags.NonPublic);
        public static string VideoPath { get; private set; }
        public static string LastError { get; private set; }
        public static string VideoStatus { get; private set; } = "Idle";
        public static bool IsVideoRecording { get { return controller != null && controller.IsRecording(); } }

        static DemoVideoSession()
        {
            DemoCapture.BeforeStop += FinalizeVideo;
            EditorApplication.update += Monitor;
        }

        public static string Start(string outputRoot, string label, bool recordVideo = true, bool lightMode = true, bool lowGraphics = true)
        {
            if (DemoCapture.IsRecording || controller != null)
                throw new InvalidOperationException("A demonstration is already active");
            LastError = null; VideoPath = null; VideoStatus = recordVideo ? "Preparing" : "Disabled";
            startCallMs = 0; startedMs = 0; startFrame = 0; ownsVideo = false;
            light = lightMode; reduceGraphics = lowGraphics; submittedFrames = 0; recorderObject = null; lastMonitorMs = 0;
            starting = true;
            try
            {
                string folder = DemoCapture.Start(outputRoot, label);
                if (!recordVideo)
                {
                    DemoCapture.SetVideoStatus(false, new { requested = false, status = "disabled" });
                    return folder;
                }
                ownsVideo = true;
                VideoPath = Path.Combine(folder, "video.mp4");
                SaveEnvironment();
                videoWidth = oldWidth; videoHeight = oldHeight;
                if (light)
                {
                    float scale = Mathf.Min(1f, Mathf.Min(960f / oldWidth, 540f / oldHeight));
                    videoWidth = Mathf.Max(2, (int)(oldWidth * scale) / 2 * 2);
                    videoHeight = Mathf.Max(2, (int)(oldHeight * scale) / 2 * 2);
                    overridesApplied = true;
                    if (reduceGraphics) QualitySettings.SetQualityLevel(0, true);
                    QualitySettings.vSyncCount = 0;
                    Application.targetFrameRate = 30;
                }
                settings = ScriptableObject.CreateInstance<RecorderControllerSettings>();
                settings.hideFlags = HideFlags.HideAndDontSave;
                settings.SetRecordModeToManual();
                settings.FrameRate = 30;
                settings.FrameRatePlayback = FrameRatePlayback.Variable;
                settings.CapFrameRate = false;
                movie = ScriptableObject.CreateInstance<MovieRecorderSettings>();
                movie.hideFlags = HideFlags.HideAndDontSave;
                movie.name = "QA demonstration video";
                movie.Enabled = true;
                movie.EncoderSettings = new CoreEncoderSettings {
                    Codec = CoreEncoderSettings.OutputCodec.MP4,
                    EncodingQuality = light ? CoreEncoderSettings.VideoEncodingQuality.Low : CoreEncoderSettings.VideoEncodingQuality.High
                };
                movie.CaptureAlpha = false;
                movie.AudioInputSettings.PreserveAudio = false;
                movie.ImageInputSettings = new GameViewInputSettings { OutputWidth = videoWidth, OutputHeight = videoHeight };
                // Public Recorder API does not expose this serialized 5.1.7 option.
                // Skip capture/readback on two frames out of three; keep input sampling each Update.
                var serializedMovie = new SerializedObject(movie);
                var nth = serializedMovie.FindProperty("captureEveryNthFrame");
                if (nth == null) throw new InvalidOperationException("Recorder 5.1.7 capture interval field not found");
                nth.intValue = light ? 3 : 1;
                serializedMovie.ApplyModifiedPropertiesWithoutUndo();
                movie.OutputFile = Path.Combine(folder, "video");
                settings.AddRecorderSettings(movie);
                controller = new RecorderController(settings);
                startCallMs = DemoCapture.ElapsedMs;
                startFrame = Time.frameCount;
                controller.PrepareRecording();
                if (!controller.StartRecording() || !controller.IsRecording())
                    throw new InvalidOperationException("Unity Recorder did not start; inspect Console");
                var sessionsField = typeof(RecorderController).GetField("m_RecordingSessions", BindingFlags.Instance | BindingFlags.NonPublic);
                var sessions = sessionsField == null ? null : sessionsField.GetValue(controller) as IEnumerable;
                if (sessions != null)
                    foreach (var session in sessions)
                        recorderObject = session.GetType().GetField("recorder").GetValue(session) as UnityEditor.Recorder.Recorder;
                startedMs = DemoCapture.ElapsedMs;
                VideoStatus = "Recording";
                Publish(false, "recording", null, null);
                DemoCapture.Mark("video_started");
                FocusGameView();
                return folder;
            }
            catch (Exception error)
            {
                LastError = "Recording start failed: " + error.GetType().Name + ": " + error.Message;
                VideoStatus = "Failed";
                DemoCapture.Stop("video_start_failed");
                throw new InvalidOperationException(LastError, error);
            }
            finally { starting = false; }
        }

        public static void Stop() { DemoCapture.Stop("user_stop"); }

        private static void Publish(bool written, string phase, string reason, double? stopCallMs)
        {
            DemoCapture.SetVideoStatus(written, new {
                requested = true, status = phase, file = "video.mp4", source = "GameView",
                audio = false, frame_rate_mode = "Variable", target_fps = 30,
                profile = light ? "LogicLight" : "Original", width = videoWidth, height = videoHeight,
                capture_every_nth_frame = light ? 3 : 1, nominal_video_fps = light ? 10 : 30,
                submitted_frames = submittedFrames, low_graphics = light && reduceGraphics,
                prior_quality_level = oldQuality, prior_target_fps = oldTargetFps,
                environment_restored = !overridesApplied,
                start_call_t_ms = startCallMs, started_t_ms = startedMs, start_frame = startFrame,
                stop_call_t_ms = stopCallMs, finalized_t_ms = stopCallMs.HasValue ? (double?)DemoCapture.ElapsedMs : null,
                bytes = VideoPath != null && File.Exists(VideoPath) ? new FileInfo(VideoPath).Length : 0,
                error = LastError, end_reason = reason,
                synchronization = "Shared Unity frame and elapsed clock; video uses Unity simulation time. Overlay/markers align across pauses and load stalls; start call is not a guaranteed first encoded frame."
            });
        }

        private static void FinalizeVideo(string reason)
        {
            if (!ownsVideo) return;
            ownsVideo = false;
            double stopMs = DemoCapture.ElapsedMs;
            UpdateFrameCount();
            try { if (controller != null) controller.StopRecording(); }
            catch (Exception error) { LastError = "Video stop failed: " + error.GetType().Name + ": " + error.Message; }
            finally
            {
                controller = null;
                if (settings != null) Object.DestroyImmediate(settings);
                if (movie != null) Object.DestroyImmediate(movie);
                settings = null; movie = null;
                recorderObject = null;
                RestoreEnvironment();
            }
            bool written = LastError == null && VideoPath != null && File.Exists(VideoPath) && new FileInfo(VideoPath).Length > 1024;
            if (!written && LastError == null) LastError = "Video file is missing or empty; combined session needs review";
            VideoStatus = written ? "Saved" : "Failed";
            Publish(written, written ? "file_written" : "failed", reason, stopMs);
        }

        private static void Monitor()
        {
            if (starting || controller == null || !DemoCapture.IsRecording || EditorApplication.isCompiling) return;
            if (DemoCapture.ElapsedMs - lastMonitorMs >= 1000)
            {
                lastMonitorMs = DemoCapture.ElapsedMs;
                // Scene initialization can reapply the game's saved quality/FPS.
                // Keep the explicitly requested temporary profile until Stop.
                if (light)
                {
                    if (reduceGraphics && QualitySettings.GetQualityLevel() != 0) QualitySettings.SetQualityLevel(0, true);
                    if (Application.targetFrameRate != 30) Application.targetFrameRate = 30;
                    if (QualitySettings.vSyncCount != 0) QualitySettings.vSyncCount = 0;
                }
                UpdateFrameCount();
                if (CountProperty != null && recorderObject != null && submittedFrames == 0 &&
                    DemoCapture.ElapsedMs - startedMs > 10000 && Time.frameCount - startFrame > 60 && !EditorApplication.isPaused)
                {
                    LastError = "No video frames captured despite game updates; stopping instead of silently recording an empty video";
                    DemoCapture.Stop("video_no_frames");
                    return;
                }
            }
            if (!controller.IsRecording())
            {
                LastError = "Unity Recorder stopped unexpectedly; both streams stopped";
                DemoCapture.Stop("video_stopped_unexpectedly");
            }
        }

        private static void UpdateFrameCount()
        {
            if (recorderObject != null && CountProperty != null)
                submittedFrames = (int)CountProperty.GetValue(recorderObject, null);
        }

        private static void SaveEnvironment()
        {
            oldQuality = QualitySettings.GetQualityLevel(); oldTargetFps = Application.targetFrameRate;
            oldVsync = QualitySettings.vSyncCount; oldWidth = Mathf.Max(2, Screen.width); oldHeight = Mathf.Max(2, Screen.height);
            var type = typeof(EditorWindow).Assembly.GetType("UnityEditor.GameView");
            gameView = type == null ? null : EditorWindow.GetWindow(type);
            sizeIndexProperty = type == null ? null : type.GetProperty("selectedSizeIndex", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            oldSizeIndex = gameView != null && sizeIndexProperty != null ? (int)sizeIndexProperty.GetValue(gameView, null) : -1;
        }

        private static void RestoreEnvironment()
        {
            if (!overridesApplied) return;
            try
            {
                QualitySettings.SetQualityLevel(oldQuality, true);
                QualitySettings.vSyncCount = oldVsync; Application.targetFrameRate = oldTargetFps;
                var helper = typeof(RecorderController).Assembly.GetType("UnityEditor.Recorder.Input.GameViewSize");
                var resize = helper == null ? null : helper.GetMethod("SetCustomSize", BindingFlags.Static | BindingFlags.Public);
                if (resize != null) resize.Invoke(null, new object[] { oldWidth, oldHeight });
                if (gameView != null && sizeIndexProperty != null && oldSizeIndex >= 0)
                    sizeIndexProperty.SetValue(gameView, oldSizeIndex, null);
                if (gameView != null) gameView.Repaint();
                overridesApplied = false;
            }
            catch (Exception error) { LastError = "Could not restore recording environment: " + error.GetType().Name; }
        }

        private static void FocusGameView()
        {
            var type = typeof(EditorWindow).Assembly.GetType("UnityEditor.GameView");
            if (type != null) EditorWindow.GetWindow(type).Focus();
        }
    }
}
#endif
