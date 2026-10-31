using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;

namespace GameQA.Agent
{
    // Reflection keeps the UPM assembly independent of the game's Assembly-CSharp.
    // Reads state only. All game control below is EventSystem drag/down/up.
    internal sealed class OceanHook : IOperation
    {
        private static readonly string[] Uids = { "LogTutotial", "BoxTutorial", "BarrelTutorial" };
        private readonly Component target, movement, touch, button;
        private readonly object activity, hook, step;
        private readonly EventInfo resultEvent;
        private readonly Action<bool> onResult;
        private readonly PointerEventData look;
        private PointerEventData press;
        private readonly Component[] targets;
        private readonly int[] ids;
        private readonly int targetId;
        private readonly string targetUid;
        private readonly float baseline, baseGain;
        private readonly Vector3 initialPosition;
        private bool dragSent, released, resultSeen, resultSuccess, sawUsing, cleaned;
        private int phase, downFrame, frames, stable;
        private float lastYaw, lastPitch, lastDx, lastDy, gainX, gainY, yawError, pitchError;
        private double clickAt;
        public bool InputSent { get; private set; }
        public bool Complete { get; private set; }
        public string Outcome { get; private set; }
        public object Evidence { get { return new { kind = "ocean.hook", target_id = targetId, target_uid = targetUid,
            input_sent = InputSent, hook_pressed = press != null, pointer_released = press == null || released,
            outcome = Outcome, throw_result_seen = resultSeen, throw_success = resultSuccess, saw_using = sawUsing,
            quest_before = baseline, quest_after = Number(step, "Value"), frames, yaw_error = yawError, pitch_error = pitchError,
            collected_ids = targets.Select((t, i) => new { t, i }).Where(x => Taken(x.t)).Select(x => ids[x.i]).ToArray() }; } }

        internal static object Observe()
        {
            var targets = Read.Components("Survival.Components.PickableComponent").Where(t =>
                Uids.Contains(Read.Member(t, "Uid") as string) && !Taken(t)).ToArray();
            var players = Read.Components("Survival.Views.Movement");
            return new { build = Application.version, supported_build = Application.version == "2.11.0", target_count = targets.Length,
                truncated = targets.Length > 16, targets = targets.Take(16).Select(t => new { id = t.GetInstanceID(), uid = Read.Member(t, "Uid"),
                    position = V(t.transform.position) }).ToArray(),
                player = players.Length == 1 ? new { id = players[0].GetInstanceID(), position = V(players[0].transform.position),
                    camera_position = Read.Member(players[0], "CameraPosition") is Vector3 ? V((Vector3)Read.Member(players[0], "CameraPosition")) : null } : null };
        }
        private static float[] V(Vector3 value) { return new[] { value.x, value.y, value.z }; }
        private static float Number(object value, string member)
        {
            var read = Read.Member(value, member);
            if (read == null) throw new InvalidOperationException("required_member_missing:" + member);
            return Convert.ToSingle(read, System.Globalization.CultureInfo.InvariantCulture);
        }
        private static bool Bool(object value, string member)
        {
            var read = Read.Member(value, member);
            if (!(read is bool)) throw new InvalidOperationException("required_member_missing:" + member);
            return (bool)read;
        }
        private static bool Taken(Component value) { return value == null || Bool(value, "IsTaken"); }
        private static object Required(object value, string name)
        {
            var result = Read.Member(value, name);
            if (result == null) throw new InvalidOperationException("required_member_missing:" + name);
            return result;
        }
        private static object[] Values(object value) { return ((IEnumerable)value).Cast<object>().ToArray(); }
        private static void ClearOverlay()
        {
            var test = Read.Single("TestGUI");
            if (Bool(test, "_isTest")) throw new InvalidOperationException("cheat_panel_open");
            if (Read.Components("Acme.Gui.Abstractions.AbstractWindowPrefab").Any(c => c.GetType().FullName != "DamageShower.DamageShowView"))
                throw new InvalidOperationException("ui_overlay");
            if (Resources.FindObjectsOfTypeAll<MonoBehaviour>().Any(c => c != null && c.isActiveAndEnabled &&
                c.GetType().Namespace == "Unity.Services.LevelPlay" && Read.Member(c, "m_Preview") is bool && (bool)Read.Member(c, "m_Preview")))
                throw new InvalidOperationException("ad_overlay");
        }

        internal OceanHook(int id)
        {
            if (Application.version != "2.11.0") throw new InvalidOperationException("unsupported_build");
            ClearOverlay();
            var test = Read.Single("TestGUI");
            var managers = Values(Required(test, "_activePanelList")).Select(p => Read.Member(p, "_questManager"))
                .Where(q => q != null).Distinct().ToArray();
            if (managers.Length != 1) throw new InvalidOperationException("quest_source_unknown");
            var quest = Values(Required(managers[0], "ActiveQuests")).SingleOrDefault(q => (string)Read.Member(q, "Uid") == "hook_use");
            if (quest == null) throw new InvalidOperationException("hook_quest_not_active");
            step = Values(Required(quest, "StartedSteps")).SingleOrDefault(s => (string)Read.Member(s, "Uid") == "use_wooden_hook");
            if (step == null || Bool(step, "IsComplete") || Number(step, "Need") != 3) throw new InvalidOperationException("hook_step_not_active");
            baseline = Number(step, "Value");
            targets = Read.Components("Survival.Components.PickableComponent").Where(t => Uids.Contains(Read.Member(t, "Uid") as string) && !Taken(t)).ToArray();
            target = targets.SingleOrDefault(t => t.GetInstanceID() == id);
            if (target == null) throw new InvalidOperationException("target_not_current_quest_object");
            targetId = id; targetUid = (string)Read.Member(target, "Uid");
            ids = targets.Select(t => t.GetInstanceID()).ToArray();
            movement = Read.Single("Survival.Views.Movement");
            if (movement.gameObject.scene != target.gameObject.scene) throw new InvalidOperationException("target_scene_mismatch");
            initialPosition = movement.transform.position;
            var hud = Read.Single("Survival.Views.UIView.UIHudControlsPanel");
            touch = Required(hud, "LookTouchpad") as Component;
            button = Values(Required(hud, "ActionButtons"))[0] as Component;
            if (touch == null || button == null) throw new InvalidOperationException("input_source_unknown");
            var callback = Required(button, "_pressExtended") as Delegate;
            if (callback == null || callback.Target == null) throw new InvalidOperationException("action_source_unknown");
            activity = Required(callback.Target, "_activityController"); hook = Required(activity, "CurrentActivity");
            if (hook.GetType().FullName != "Survival.Activities.Hook" || Bool(activity, "IsUsing")) throw new InvalidOperationException("hook_not_ready");
            var player = Required(callback.Target, "_player");
            baseGain = Number(touch, "_sens") * Number(player, "Sensitivity");
            if (baseGain <= 0 || float.IsNaN(baseGain) || float.IsInfinity(baseGain)) throw new InvalidOperationException("invalid_sensitivity");
            gainX = gainY = baseGain; lastYaw = Number(movement, "Yaw"); lastPitch = Number(movement, "Pitch");
            look = UiInput.Pointer(touch.gameObject, true);
            resultEvent = hook.GetType().GetEvent("OnThrowResult");
            if (resultEvent == null || resultEvent.EventHandlerType != typeof(Action<bool>)) throw new InvalidOperationException("hook_event_unknown");
            onResult = value => { resultSeen = true; resultSuccess = value; };
            resultEvent.AddEventHandler(hook, onResult); // Last constructor action: no abandoned subscription on validation failure.
        }

        public void Frame()
        {
            frames++;
            if (movement == null || touch == null || button == null) { Finish("input_source_changed"); return; }
            if (Vector3.Distance(initialPosition, movement.transform.position) > .25f) { Finish("player_moved"); return; }
            if (Read.Member(activity, "CurrentActivity") != hook) { Finish("activity_changed"); return; }
            if (phase == 3)
            {
                if (Time.frameCount <= downFrame) return;
                released = true; UiInput.Release(button.gameObject, press, false); phase = 4;
            }
            if (phase == 4)
            {
                sawUsing |= Bool(activity, "IsUsing");
                var elapsed = EditorApplication.timeSinceStartup - clickAt;
                if (elapsed < 3) return;
                if (Bool(activity, "IsUsing") && elapsed < 5) return;
                if (Bool(activity, "IsUsing")) { Finish("hook_result_timeout"); return; }
                var progress = Number(step, "Value") > baseline;
                if (resultSeen && resultSuccess && progress && Taken(target)) Finish("verified");
                else if (resultSeen && resultSuccess && progress) Finish("other_target_collected");
                else Finish(sawUsing ? "miss_or_unverified_result" : "click_no_action");
                return;
            }
            if (frames > 150) { Finish("aim_not_converging"); return; }
            if (Taken(target) || !target.gameObject.activeInHierarchy) { Finish("target_changed"); return; }
            if (Bool(movement, "_isRotaion")) return;
            var collider = target.GetComponentInChildren<Collider>();
            var aim = collider != null && collider.enabled ? collider.bounds.center : target.transform.position;
            var vector = aim - (Vector3)Required(movement, "CameraPosition");
            if (vector.magnitude < .1f || vector.magnitude > 12) { Finish("range_outside_skill"); return; }
            var forward = ((Vector3)Required(movement, "CameraForward")).normalized;
            yawError = Vector3.SignedAngle(Vector3.ProjectOnPlane(forward, Vector3.up), Vector3.ProjectOnPlane(vector, Vector3.up), Vector3.up);
            pitchError = Mathf.Atan2(vector.y, new Vector2(vector.x, vector.z).magnitude) * Mathf.Rad2Deg - Mathf.Asin(Mathf.Clamp(forward.y, -1, 1)) * Mathf.Rad2Deg;
            var yaw = Number(movement, "Yaw"); var pitch = Number(movement, "Pitch");
            var yawMotion = Mathf.DeltaAngle(lastYaw, yaw); var pitchMotion = pitch - lastPitch;
            if (phase == 2)
            {
                stable = Mathf.Abs(yawMotion) < .05f && Mathf.Abs(pitchMotion) < .05f ? stable + 1 : 0;
                lastYaw = yaw; lastPitch = pitch;
                if (stable < 2) return;
                if (Mathf.Abs(yawError) > 1.5f || Mathf.Abs(pitchError) > 1.5f) phase = 0;
                else
                {
                    ClearOverlay();
                    if (Bool(step, "IsComplete")) { Finish("quest_step_changed"); return; }
                    if (Bool(activity, "IsUsing")) { Finish("hook_busy"); return; }
                    press = UiInput.Pointer(button.gameObject, false);
                    AgentAdapter.Guard();
                    InputSent = true; downFrame = Time.frameCount; clickAt = EditorApplication.timeSinceStartup; phase = 3;
                    ExecuteEvents.Execute(button.gameObject, press, ExecuteEvents.pointerDownHandler);
                    sawUsing = Bool(activity, "IsUsing"); return;
                }
            }
            if (Mathf.Abs(lastDx) > 1 && Mathf.Abs(yawMotion) > .01f) gainX = Mathf.Clamp(Mathf.Abs(yawMotion / lastDx), baseGain * .25f, baseGain * 8);
            if (Mathf.Abs(lastDy) > 1 && Mathf.Abs(pitchMotion) > .01f) gainY = Mathf.Clamp(Mathf.Abs(pitchMotion / lastDy), baseGain * .25f, baseGain * 8);
            lastYaw = yaw; lastPitch = pitch;
            if (Mathf.Abs(yawError) < .7f && Mathf.Abs(pitchError) < .7f)
            {
                EndLook(); phase = 2; stable = 0; lastDx = lastDy = 0; return;
            }
            lastDx = Mathf.Clamp(yawError * .65f / gainX, -120, 120);
            lastDy = Mathf.Clamp(pitchError * .65f / gainY, -120, 120);
            look.delta = new Vector2(lastDx, lastDy); look.position += look.delta;
            AgentAdapter.Guard();
            InputSent = true; dragSent = true;
            ExecuteEvents.Execute(touch.gameObject, look, ExecuteEvents.dragHandler);
        }
        private void Finish(string outcome) { Outcome = outcome; Complete = true; }
        private void EndLook()
        {
            look.delta = Vector2.zero;
            if (!dragSent || touch == null) return;
            dragSent = false; ExecuteEvents.Execute(touch.gameObject, look, ExecuteEvents.endDragHandler);
        }
        public void Release()
        {
            if (cleaned) return;
            cleaned = true;
            try { EndLook(); }
            finally
            {
                try { if (press != null && !released) { released = true; UiInput.Release(button == null ? null : button.gameObject, press, true); } }
                finally { resultEvent.RemoveEventHandler(hook, onResult); }
            }
        }
    }
}
