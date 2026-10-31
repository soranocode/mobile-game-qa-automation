#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;
using Object = UnityEngine.Object;

namespace QaDemonstrations
{
    // Reads existing objects only; never resolves DI services, loads assets, or invokes game actions.
    internal static class OceanNomadObservation
    {
        private static Component movement;
        private static ScriptableObject joysSettings;
        private static float refreshAt;
        internal static Component MovementComponent { get { Refresh(); return movement; } }
        public static void Invalidate() { movement = null; joysSettings = null; refreshAt = 0; }
        private static Type FindType(string name)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(name, false);
                if (type != null) return type;
            }
            return null;
        }
        private static object Property(object value, string name)
        {
            if (value == null) return null;
            var property = value.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
            return property == null ? null : property.GetValue(value, null);
        }
        private static float[] V(Vector3 v) { return new[] { v.x, v.y, v.z }; }
        private static float[] Q(Quaternion q) { return new[] { q.x, q.y, q.z, q.w }; }
        private static void Refresh()
        {
            if (Time.unscaledTime < refreshAt) return;
            refreshAt = Time.unscaledTime + 1;
            var type = FindType("Survival.Views.Movement");
            if (type != null)
            {
                var candidates = Resources.FindObjectsOfTypeAll(type).OfType<Component>()
                    .Where(c => c != null && c.gameObject.scene.IsValid() && c.gameObject.scene.isLoaded && c.gameObject.activeInHierarchy).ToArray();
                movement = candidates.Length == 1 ? candidates[0] : null;
            }
            type = FindType("Acme.Joys.JoysPlayerSettings");
            if (type != null)
            {
                var candidates = Resources.FindObjectsOfTypeAll(type).OfType<ScriptableObject>().ToArray();
                joysSettings = candidates.Length == 1 ? candidates[0] : null;
            }
        }
        public static object Read()
        {
            Refresh();
            object player = null;
            object camera = null;
            object signals = null;
            if (movement != null && movement.gameObject.activeInHierarchy)
            {
                var tf = movement.transform;
                player = new { instance_id = movement.GetInstanceID(), scene = movement.gameObject.scene.path,
                    position = V(tf.position), rotation = Q(tf.rotation), grounded = Property(movement, "Grounded"),
                    parent_id = tf.parent == null ? 0 : tf.parent.GetInstanceID(), local_position = V(tf.localPosition) };
                var position = Property(movement, "CameraPosition");
                var forward = Property(movement, "CameraForward");
                if (position is Vector3 && forward is Vector3 && ((Vector3)forward).sqrMagnitude > 0.01f)
                    camera = new { position = V((Vector3)position), forward = V((Vector3)forward), source = "Movement.CameraPosition/CameraForward" };
            }
            if (joysSettings != null)
            {
                var joys = Property(joysSettings, "Joys");
                if (joys != null)
                {
                    var values = new Dictionary<string, object>();
                    foreach (var name in new[] { "Straight", "Sideways", "Pitch", "Yaw", "Sprint" })
                    {
                        var field = joys.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public);
                        var axis = field == null ? null : field.GetValue(joys);
                        var value = Property(axis, "Value");
                        values[name] = value;
                    }
                    signals = new { source = "existing JoysPlayerSettings; sampled values, consumption not proven", axes = values };
                }
            }
            return new { player = player, camera = camera, game_signals = signals, coordinate_units = "unity_units" };
        }
        public static bool TryGrounded(out bool grounded)
        {
            Refresh();
            var value = movement == null ? null : Property(movement, "Grounded");
            grounded = value is bool && (bool)value;
            return value is bool;
        }
    }
}
#endif
