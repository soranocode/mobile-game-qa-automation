#if UNITY_EDITOR
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace QaDemonstrations
{
    // Geometry only. This never rotates a camera, moves a player or claims a route is safe.
    public static class WorldTargetProjection
    {
        internal static JToken Number(float value, int digits = 3)
        {
            if (float.IsNaN(value) || float.IsInfinity(value)) return JValue.CreateNull();
            return new JValue(System.Math.Round(value, digits));
        }

        internal static JArray Vector(Vector3 value)
        {
            return new JArray(Number(value.x), Number(value.y), Number(value.z));
        }

        public static JObject Describe(Vector3? playerPosition, Vector3? cameraPosition,
            Vector3? cameraForward, Vector3 targetPosition)
        {
            var result = new JObject {
                ["aim_point_world"] = Vector(targetPosition),
                ["distance_from_player"] = playerPosition.HasValue ? Number(Vector3.Distance(playerPosition.Value, targetPosition)) : JValue.CreateNull(),
                ["distance_from_camera"] = cameraPosition.HasValue ? Number(Vector3.Distance(cameraPosition.Value, targetPosition)) : JValue.CreateNull(),
                ["offset_from_player_world"] = playerPosition.HasValue ? Vector(targetPosition - playerPosition.Value) : null,
                ["yaw_error_degrees_positive_right"] = null,
                ["elevation_error_degrees_positive_up"] = null,
                ["visible"] = null, ["reachable"] = null, ["path_status"] = "not_evaluated"
            };
            if (!cameraPosition.HasValue || !cameraForward.HasValue || cameraForward.Value.sqrMagnitude < 0.000001f)
                return result;
            var delta = targetPosition - cameraPosition.Value;
            if (delta.sqrMagnitude < 0.000001f) return result;
            var forward = cameraForward.Value;
            var flatForward = Vector3.ProjectOnPlane(forward, Vector3.up);
            var flatDelta = Vector3.ProjectOnPlane(delta, Vector3.up);
            if (flatForward.sqrMagnitude > 0.000001f && flatDelta.sqrMagnitude > 0.000001f)
                result["yaw_error_degrees_positive_right"] = Number(Vector3.SignedAngle(flatForward, flatDelta, Vector3.up), 1);
            var targetElevation = Mathf.Atan2(delta.y, flatDelta.magnitude) * Mathf.Rad2Deg;
            var viewElevation = Mathf.Atan2(forward.y, flatForward.magnitude) * Mathf.Rad2Deg;
            result["elevation_error_degrees_positive_up"] = Number(targetElevation - viewElevation, 1);
            return result;
        }
    }
}
#endif
