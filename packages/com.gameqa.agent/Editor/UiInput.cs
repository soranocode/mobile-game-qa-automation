using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace GameQA.Agent
{
    internal static class UiInput
    {
        internal static string Path(GameObject go)
        {
            var path = go.name;
            for (var p = go.transform.parent; p != null; p = p.parent) path = p.name + "/" + path;
            return path;
        }

        internal static GameObject[] Find(JObject selector)
        {
            var path = (string)selector["path"];
            var name = (string)selector["name"];
            var type = (string)selector["component"];
            var ancestor = (string)selector["ancestor"];
            if (string.IsNullOrWhiteSpace(path) && string.IsNullOrWhiteSpace(name) && string.IsNullOrWhiteSpace(type))
                throw new ArgumentException("empty_selector");
            // Concrete component selectors query that type only, including during local effect waits.
            // Path/name selectors retain the full uniqueness check rather than GameObject.Find's first match.
            var objects = type == null ? Resources.FindObjectsOfTypeAll<GameObject>() : Read.Components(type)
                .Where(c => c.GetType().FullName == type).Select(c => c.gameObject).Distinct().ToArray();
            return objects.Where(go => go != null && go.activeInHierarchy &&
                go.scene.IsValid() && go.scene.isLoaded && (path == null || Path(go) == path) &&
                (name == null || go.name == name) && (type == null || go.GetComponents<Component>().Any(c => c != null && c.GetType().FullName == type)) &&
                (ancestor == null || Ancestor(go, ancestor))).ToArray();
        }

        private static bool Ancestor(GameObject go, string name)
        {
            for (var p = go.transform.parent; p != null; p = p.parent) if (p.name == name) return true;
            return false;
        }

        internal static void Available(GameObject target)
        {
            if (target == null || !target.activeInHierarchy) throw new InvalidOperationException("target_unavailable");
            var selectable = target.GetComponent<Selectable>();
            if (selectable != null && !selectable.IsInteractable()) throw new InvalidOperationException("target_blocked");
            foreach (var component in target.GetComponents<MonoBehaviour>())
            {
                if (component == null) continue;
                if (!component.isActiveAndEnabled) continue;
                var blocked = Read.Member(component, "BlockButton");
                if (blocked is bool && (bool)blocked) throw new InvalidOperationException("target_blocked");
            }
        }

        internal static PointerEventData Pointer(GameObject target, bool drag)
        {
            Available(target);
            var es = EventSystem.current;
            var rect = target.GetComponent<RectTransform>();
            var canvas = target.GetComponentInParent<Canvas>();
            if (es == null || rect == null || canvas == null) throw new InvalidOperationException("input_geometry_missing");
            var pos = RectTransformUtility.WorldToScreenPoint(canvas.renderMode == RenderMode.ScreenSpaceOverlay ? null : canvas.worldCamera,
                rect.TransformPoint(rect.rect.center));
            var pointer = new PointerEventData(es) { position = pos, pressPosition = pos,
                pointerId = -901, button = PointerEventData.InputButton.Left, eligibleForClick = !drag,
                clickCount = 1, clickTime = Time.unscaledTime, useDragThreshold = false };
            var hits = new List<RaycastResult>(); es.RaycastAll(pointer, hits);
            if (hits.Count == 0 || !hits[0].gameObject.transform.IsChildOf(target.transform))
                throw new InvalidOperationException("target_covered");
            var handler = drag ? ExecuteEvents.GetEventHandler<IDragHandler>(hits[0].gameObject) :
                ExecuteEvents.GetEventHandler<IPointerDownHandler>(hits[0].gameObject);
            if (handler != target) throw new InvalidOperationException("input_handler_mismatch");
            pointer.pointerCurrentRaycast = hits[0]; pointer.pointerPressRaycast = hits[0];
            pointer.pointerPress = target; pointer.rawPointerPress = hits[0].gameObject;
            pointer.pointerDrag = drag ? target : null;
            return pointer;
        }

        internal static void Release(GameObject target, PointerEventData pointer, bool cancel)
        {
            if (target == null || pointer == null) return;
            if (cancel) { pointer.eligibleForClick = false; pointer.position = new Vector2(-100000, -100000); }
            ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerUpHandler);
        }
    }

    internal sealed class UiClick : IOperation
    {
        private readonly GameObject target;
        private readonly JObject expect;
        private readonly PointerEventData pointer;
        private readonly double wait;
        private int phase, downFrame;
        private double sentAt;
        private bool released;
        public bool InputSent { get; private set; }
        public bool Complete { get; private set; }
        public string Outcome { get; private set; }
        public object Evidence { get { return new { kind = "ui.click", target_path = targetPath,
            input_sent = InputSent, pointer_released = released, outcome = Outcome, effect_checked = expect != null }; } }
        private readonly string targetPath;

        internal UiClick(JObject spec)
        {
            var matches = UiInput.Find((JObject)spec["selector"]);
            if (matches.Length != 1) throw new InvalidOperationException("selector_match_count:" + matches.Length);
            target = matches[0]; targetPath = UiInput.Path(target);
            expect = spec["expect"] as JObject;
            wait = (double?)spec["wait_seconds"] ?? 3;
            pointer = UiInput.Pointer(target, false);
            if (expect != null && Effect()) throw new InvalidOperationException("expect_already_satisfied");
        }

        private bool Effect()
        {
            var matches = UiInput.Find((JObject)expect["selector"]);
            return (bool)expect["present"] ? matches.Length == 1 : matches.Length == 0;
        }

        public void Frame()
        {
            if (phase == 0)
            {
                AgentAdapter.Guard();
                InputSent = true; downFrame = Time.frameCount; phase = 1;
                ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerDownHandler);
                return;
            }
            if (phase == 1)
            {
                if (Time.frameCount <= downFrame) return;
                UiInput.Available(target);
                var fresh = UiInput.Pointer(target, false);
                pointer.position = fresh.position; pointer.pointerCurrentRaycast = fresh.pointerCurrentRaycast;
                AgentAdapter.Guard();
                released = true; UiInput.Release(target, pointer, false);
                AgentAdapter.Guard();
                // Some custom buttons act on Up, standard UGUI Button acts on Click.
                if (target != null && target.activeInHierarchy && pointer.eligibleForClick)
                    ExecuteEvents.Execute(target, pointer, ExecuteEvents.pointerClickHandler);
                sentAt = EditorApplication.timeSinceStartup; phase = 2;
            }
            if (expect == null) { Complete = true; Outcome = "input_sent"; return; }
            if (Effect()) { Complete = true; Outcome = "verified"; }
            else if (EditorApplication.timeSinceStartup - sentAt >= wait) { Complete = true; Outcome = "effect_not_observed"; }
        }

        public void Release()
        {
            if (!InputSent || released) return;
            released = true; UiInput.Release(target, pointer, true);
        }
    }

    internal static class Read
    {
        internal static object Member(object value, string name)
        {
            if (value == null || (value is UnityEngine.Object && (UnityEngine.Object)value == null)) return null;
            const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance |
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
            for (var type = value.GetType(); type != null; type = type.BaseType)
            {
                var property = type.GetProperty(name, flags | System.Reflection.BindingFlags.DeclaredOnly);
                if (property != null && property.GetIndexParameters().Length == 0) return property.GetValue(value, null);
                var field = type.GetField(name, flags | System.Reflection.BindingFlags.DeclaredOnly);
                if (field != null) return field.GetValue(value);
            }
            return null;
        }
        internal static Component[] Components(string fullName)
        {
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fullName, false)).FirstOrDefault(t => t != null);
            return type == null ? new Component[0] : Resources.FindObjectsOfTypeAll(type).OfType<Component>()
                .Where(c => c != null && c.gameObject.activeInHierarchy && c.gameObject.scene.IsValid() && c.gameObject.scene.isLoaded).ToArray();
        }
        internal static Component Single(string fullName)
        {
            var values = Components(fullName);
            if (values.Length != 1) throw new InvalidOperationException("source_match_count:" + fullName + ":" + values.Length);
            return values[0];
        }
    }
}
