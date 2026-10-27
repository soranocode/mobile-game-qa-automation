#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace QaDemonstrations.Editor
{
    [InitializeOnLoad]
    public static class DemoRecorderLifecycle
    {
        static DemoRecorderLifecycle()
        {
            EditorApplication.update += DemoCapture.EditorTick;
            EditorApplication.playModeStateChanged += state => {
                if (state == PlayModeStateChange.ExitingPlayMode) DemoCapture.Stop("play_mode_exiting");
            };
            AssemblyReloadEvents.beforeAssemblyReload += () => DemoCapture.Stop("domain_reload");
            EditorApplication.quitting += () => DemoCapture.Stop("editor_quitting");
        }
    }

    public sealed class DemoRecorderWindow : EditorWindow
    {
        private string label = "";
        private string marker = "";
        private string outputRoot;
        private bool recordVideo = true;
        private bool lightMode = true;
        private bool lowGraphics = true;
        [MenuItem("Window/QA/Demonstration Recorder")]
        public static void Open() { GetWindow<DemoRecorderWindow>("QA Demonstration"); }
        private void OnEnable()
        {
            var project = Directory.GetParent(Application.dataPath).FullName;
            string durableRoot = Path.Combine(Directory.GetParent(project).FullName, Path.GetFileName(project) + "-qa-demonstrations");
            outputRoot = EditorPrefs.GetString("QaDemonstrations.OutputRoot", durableRoot);
            if (outputRoot == Path.Combine(project, "Temp", "QaDemonstrations")) outputRoot = durableRoot;
        }
        private void OnInspectorUpdate() { Repaint(); }
        private void OnGUI()
        {
            EditorGUILayout.LabelField("Game QA Demonstration Recorder " + RecorderPackage.Version, EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("Start in Play without pause. One button records Game View video and actions into the same session folder. F8 adds an optional sync marker. Video has no audio.", MessageType.Info);
            using (new EditorGUI.DisabledScope(DemoCapture.IsRecording))
            {
                label = EditorGUILayout.TextField("Session goal", label);
                outputRoot = EditorGUILayout.TextField("Local output root", outputRoot);
                DemoCapture.ShowOverlay = EditorGUILayout.Toggle("Timecode overlay", DemoCapture.ShowOverlay);
                recordVideo = EditorGUILayout.Toggle("Record video (Game View)", recordVideo);
                if (recordVideo)
                {
                    lightMode = EditorGUILayout.Toggle("Light recording (540p / ~10fps)", lightMode);
                    if (lightMode) lowGraphics = EditorGUILayout.Toggle("Low graphics while recording", lowGraphics);
                }
                using (new EditorGUI.DisabledScope(!EditorApplication.isPlaying || EditorApplication.isPaused))
                    if (GUILayout.Button(recordVideo ? "Start video + actions" : "Start actions only"))
                    {
                        try {
                            DemoVideoSession.Start(outputRoot, label, recordVideo, lightMode, lowGraphics);
                            EditorPrefs.SetString("QaDemonstrations.OutputRoot", outputRoot);
                        } catch (Exception error) { Debug.LogError("QA recorder: " + error.Message); }
                    }
            }
            using (new EditorGUI.DisabledScope(!DemoCapture.IsRecording))
            {
                if (GUILayout.Button("Stop and save")) DemoVideoSession.Stop();
                marker = EditorGUILayout.TextField("Annotation", marker);
                if (GUILayout.Button("Add annotation marker")) DemoCapture.Mark(marker);
            }
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Status", DemoCapture.IsRecording ? "RECORDING" : "Idle");
            EditorGUILayout.LabelField("Elapsed", (DemoCapture.ElapsedMs / 1000).ToString("F2") + " s");
            EditorGUILayout.LabelField("Samples", DemoCapture.InputEvents + " input / " + DemoCapture.StateEvents + " state");
            EditorGUILayout.LabelField("Video", DemoVideoSession.VideoStatus);
            if (DemoCapture.IsRecording) EditorGUILayout.LabelField("Update cadence", DemoCapture.UpdateFps.ToString("F1") + " fps");
            if (!string.IsNullOrEmpty(DemoCapture.LastFolder)) EditorGUILayout.SelectableLabel(DemoCapture.LastFolder, GUILayout.Height(42));
            if (!DemoCapture.IsRecording && !string.IsNullOrEmpty(DemoCapture.LastFolder) && GUILayout.Button("Open session folder")) EditorUtility.RevealInFinder(DemoCapture.LastFolder);
            if (!string.IsNullOrEmpty(DemoCapture.LastError)) EditorGUILayout.HelpBox(DemoCapture.LastError, MessageType.Error);
            if (!string.IsNullOrEmpty(DemoVideoSession.LastError)) EditorGUILayout.HelpBox(DemoVideoSession.LastError, MessageType.Error);
        }
    }
}
#endif
