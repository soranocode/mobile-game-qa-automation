#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace QaDemonstrations
{
    [InitializeOnLoad]
    internal static class OceanNomadTelemetryRegistration
    {
        static OceanNomadTelemetryRegistration()
        {
            DemoCapture.SessionStarted += OceanNomadTelemetry.Begin;
            DemoCapture.StateSampled += OceanNomadTelemetry.Sample;
            DemoCapture.BeforeStop += OceanNomadTelemetry.End;
        }
    }

    // Only reads existing game objects/references. No Resolve, signal Fire, quest or pickup actions.
    public static class OceanNomadTelemetry
    {
        private const int QuestLimit = 16, StepLimit = 32, TargetLimit = 32, ScanLimit = 4096;
        private static readonly Dictionary<string, MemberInfo> members = new Dictionary<string, MemberInfo>();
        private static readonly HashSet<string> observedQuests = new HashSet<string>();
        private static readonly HashSet<string> observedCollectUids = new HashSet<string>();
        private static Component[] pickables = new Component[0];
        private static object manager;
        private static Type questObjectType;
        private static double refreshAt = -1, nextSampleAt = -1, lastEmitAt = -1;
        private static string managerSource = "unavailable", sourceError;
        private static bool scanTruncated;
        private static bool observedQuestLimitReached, observedTargetLimitReached;
        private static JObject lastQuest, lastSpatial;

        private static Type FindType(string name)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(name, false);
                if (type != null) return type;
            }
            return null;
        }

        private static object Get(object value, string name)
        {
            if (value == null) return null;
            if (value is UnityEngine.Object && (UnityEngine.Object)value == null) return null;
            var type = value.GetType();
            var key = type.AssemblyQualifiedName + ":" + name;
            MemberInfo member;
            if (!members.TryGetValue(key, out member))
            {
                var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
                member = type.GetProperty(name, flags);
                for (var current = type; member == null && current != null; current = current.BaseType)
                    member = current.GetField(name, flags | BindingFlags.DeclaredOnly);
                members[key] = member;
            }
            var property = member as PropertyInfo;
            if (property != null && property.GetIndexParameters().Length == 0) return property.GetValue(value, null);
            var field = member as FieldInfo;
            return field == null ? null : field.GetValue(value);
        }

        private static string Id(object value)
        {
            var text = value as string;
            if (string.IsNullOrWhiteSpace(text) || text.Length > 160) return null;
            // Identifier fields only; never capture entered text or password parameters.
            if (text.Any(char.IsControl)) return null;
            return text;
        }

        private static List<object> List(object value, int limit, out bool truncated)
        {
            var result = new List<object>();
            truncated = false;
            var enumerable = value as IEnumerable;
            if (enumerable == null || value is string) return result;
            foreach (var item in enumerable)
            {
                if (result.Count >= limit) { truncated = true; break; }
                result.Add(item);
            }
            return result;
        }

        private static JToken Scalar(object value)
        {
            if (value is bool || value is int || value is long) return JToken.FromObject(value);
            return JValue.CreateNull();
        }

        private static Component[] Components(string typeName)
        {
            var type = FindType(typeName);
            if (type == null) return new Component[0];
            return Resources.FindObjectsOfTypeAll(type).OfType<Component>()
                .Where(c => c != null && c.gameObject.scene.IsValid() && c.gameObject.scene.isLoaded).ToArray();
        }

        private static void RefreshSources()
        {
            var now = EditorApplication.timeSinceStartup;
            if (now < refreshAt) return;
            refreshAt = now + 1.0;
            manager = null; managerSource = "unavailable"; sourceError = null;
            var managers = new List<object>();
            foreach (var gui in Components("TestGUI").Where(c => c.gameObject.activeInHierarchy))
            {
                bool cut;
                foreach (var panel in List(Get(gui, "_activePanelList"), 128, out cut))
                {
                    var candidate = Get(panel, "_questManager");
                    if (candidate != null && candidate.GetType().FullName == "Quests.QuestManager" &&
                        !managers.Any(existing => ReferenceEquals(existing, candidate))) managers.Add(candidate);
                }
            }
            if (managers.Count == 1)
            {
                manager = managers[0];
                managerSource = "existing TestGUI._activePanelList[*]._questManager";
            }
            else if (managers.Count > 1) sourceError = "ambiguous_quest_managers";
            var allPickables = Components("Survival.Components.PickableComponent");
            scanTruncated = allPickables.Length > ScanLimit;
            pickables = allPickables.Take(ScanLimit).ToArray();
            questObjectType = FindType("Quests.Objects.QuestObject");
        }

        private static JObject ReadQuestState(object source)
        {
            var result = new JObject {
                ["availability"] = source == null ? "unknown" : "available",
                ["source"] = managerSource, ["source_error"] = sourceError,
                ["loaded"] = null, ["tracked_quest_uid"] = null, ["active_quests"] = null,
                ["active_collect_target_uids"] = null, ["observed_collect_target_uids"] = new JArray(observedCollectUids.OrderBy(x => x)),
                ["history_completed_observed_quest_uids"] = null,
                ["completion_note"] = "History membership is not a fresh quest-completion signal."
            };
            if (source == null) return result;
            result["loaded"] = Scalar(Get(Get(source, "IsLoaded"), "Value"));
            result["tracked_quest_uid"] = Id(Get(Get(Get(source, "TrackedQuest"), "Value"), "Uid"));
            var activeSource = Get(source, "ActiveQuests");
            if (!(activeSource is IEnumerable)) { result["availability"] = "unsupported_contract"; return result; }
            bool questsCut;
            var quests = List(activeSource, QuestLimit, out questsCut);
            var output = new JArray();
            var targetUids = new HashSet<string>();
            foreach (var quest in quests)
            {
                var uid = Id(Get(quest, "Uid"));
                if (uid != null && !observedQuests.Contains(uid))
                {
                    if (observedQuests.Count < 64) observedQuests.Add(uid);
                    else observedQuestLimitReached = true;
                }
                bool activeCut, startedCut;
                var active = List(Get(quest, "ActiveSteps"), StepLimit, out activeCut);
                var started = List(Get(quest, "StartedSteps"), StepLimit, out startedCut);
                var activeIds = new HashSet<string>(active.Select(s => Id(Get(s, "Uid"))).Where(x => x != null));
                var steps = new JArray();
                var mergedSteps = started.Concat(active).GroupBy(s => Id(Get(s, "Uid"))).Select(g => g.First()).ToArray();
                foreach (var step in mergedSteps.Take(StepLimit))
                {
                    var stepUid = Id(Get(step, "Uid"));
                    var typeValue = Get(Get(step, "Data"), "Type");
                    var kind = typeValue == null ? null : typeValue.ToString();
                    bool parametersCut;
                    var parameters = List(Get(Get(step, "Parameters"), "Parameters"), 64, out parametersCut);
                    var allUids = parameters.Where(p => Id(Get(p, "Key")) == "uid")
                        .Select(p => Id(Get(p, "Value"))).Where(x => x != null).Distinct().ToArray();
                    var uids = allUids.Take(32).ToArray();
                    var isActive = stepUid != null && activeIds.Contains(stepUid);
                    if (isActive && kind == "ObjectCollect")
                        foreach (var target in uids)
                        {
                            targetUids.Add(target);
                            if (!observedCollectUids.Contains(target))
                            {
                                if (observedCollectUids.Count < 64) observedCollectUids.Add(target);
                                else observedTargetLimitReached = true;
                            }
                        }
                    steps.Add(new JObject {
                        ["uid"] = stepUid, ["type"] = kind, ["active"] = isActive,
                        ["value"] = Scalar(Get(step, "Value")), ["need"] = Scalar(Get(step, "Need")),
                        ["is_complete"] = Scalar(Get(step, "IsComplete")), ["target_uids"] = new JArray(uids),
                        ["world_target_resolution_supported"] = kind == "ObjectCollect" && uids.Length > 0,
                        ["parameters_truncated"] = parametersCut, ["target_uids_truncated"] = allUids.Length > 32
                    });
                }
                output.Add(new JObject { ["uid"] = uid, ["is_finished"] = Scalar(Get(quest, "IsFinished")),
                    ["active_step_uids"] = new JArray(activeIds.OrderBy(x => x)), ["steps"] = steps,
                    ["steps_truncated"] = activeCut || startedCut || mergedSteps.Length > StepLimit });
            }
            bool historyCut;
            var historySource = Get(source, "CompletedQuests");
            var history = List(historySource, 512, out historyCut);
            result["active_quests"] = output;
            result["quests_truncated"] = questsCut;
            result["active_collect_target_uids"] = new JArray(targetUids.OrderBy(x => x));
            result["observed_collect_target_uids"] = new JArray(observedCollectUids.OrderBy(x => x));
            result["history_completed_observed_quest_uids"] = historySource is IEnumerable ?
                new JArray(history.Select(q => Id(Get(q, "Uid"))).Where(uid => uid != null && observedQuests.Contains(uid)).Distinct().OrderBy(x => x)) : null;
            result["history_scan_truncated"] = historyCut;
            result["observed_quest_limit_reached"] = observedQuestLimitReached;
            result["observed_target_limit_reached"] = observedTargetLimitReached;
            return result;
        }

        private static JObject PlayerFrame(Component movement)
        {
            if (movement == null) return null;
            var parent = movement.transform.parent;
            return new JObject {
                ["player_instance_id"] = movement.GetInstanceID(), ["scene_path"] = movement.gameObject.scene.path,
                ["scene_handle"] = movement.gameObject.scene.handle,
                ["position_world"] = WorldTargetProjection.Vector(movement.transform.position),
                ["parent_instance_id"] = parent == null ? 0 : parent.GetInstanceID(),
                ["position_in_parent"] = WorldTargetProjection.Vector(movement.transform.localPosition),
                ["parent_position_world"] = parent == null ? null : WorldTargetProjection.Vector(parent.position),
                ["parent_rotation_world"] = parent == null ? null : new JArray(parent.rotation.x, parent.rotation.y, parent.rotation.z, parent.rotation.w),
                ["parent_scale"] = parent == null ? null : WorldTargetProjection.Vector(parent.lossyScale)
            };
        }

        private static JObject ReadSpatial(HashSet<string> uids, float? radius, int limit)
        {
            var movement = OceanNomadObservation.MovementComponent;
            var player = movement == null ? null : movement.transform;
            var cameraPositionValue = Get(movement, "CameraPosition");
            var cameraForwardValue = Get(movement, "CameraForward");
            Vector3? cameraPosition = cameraPositionValue is Vector3 ? (Vector3?)cameraPositionValue : null;
            Vector3? cameraForward = cameraForwardValue is Vector3 ? (Vector3?)cameraForwardValue : null;
            Vector3? playerPosition = player == null ? null : (Vector3?)player.position;
            var candidates = pickables.Where(p => p != null && (uids == null || uids.Contains(Id(Get(p, "Uid")))))
                .Where(p => !radius.HasValue || (player != null && Vector3.Distance(p.transform.position, player.position) <= radius.Value))
                .OrderByDescending(p => p.gameObject.activeInHierarchy)
                .ThenBy(p => player == null ? 0f : (p.transform.position - player.position).sqrMagnitude).ThenBy(p => p.GetInstanceID()).Take(limit + 1).ToArray();
            var targets = new JArray();
            foreach (var item in candidates.Take(limit))
            {
                var collider = item.GetComponent<Collider>() ?? item.GetComponentInChildren<Collider>(true);
                bool liveCollider = collider != null && collider.enabled && collider.gameObject.activeInHierarchy;
                var aim = liveCollider ? collider.bounds.center : item.transform.position;
                object questObject = null;
                if (questObjectType != null)
                    for (var tf = item.transform; tf != null && questObject == null; tf = tf.parent)
                        questObject = tf.GetComponent(questObjectType);
                var target = WorldTargetProjection.Describe(playerPosition, cameraPosition, cameraForward, aim);
                target["uid"] = Id(Get(item, "Uid"));
                target["instance_id"] = item.GetInstanceID();
                target["quest_object_id"] = Id(Get(questObject, "Id"));
                target["scene_path"] = item.gameObject.scene.path;
                target["scene_handle"] = item.gameObject.scene.handle;
                target["position_world"] = WorldTargetProjection.Vector(item.transform.position);
                target["parent_instance_id"] = item.transform.parent == null ? 0 : item.transform.parent.GetInstanceID();
                target["position_in_own_parent"] = WorldTargetProjection.Vector(item.transform.localPosition);
                target["position_in_player_parent"] = player == null || player.parent == null ? null : WorldTargetProjection.Vector(player.parent.InverseTransformPoint(item.transform.position));
                target["active_in_hierarchy"] = item.gameObject.activeInHierarchy;
                target["component_enabled"] = item is Behaviour ? new JValue(((Behaviour)item).enabled) : JValue.CreateNull();
                target["is_taken"] = Scalar(Get(item, "IsTaken"));
                target["can_pickup_flag"] = Scalar(Get(item, "CanPickup"));
                target["collider_enabled_and_active"] = liveCollider;
                target["aim_source"] = liveCollider ? "collider_bounds_center" : "transform_fallback";
                target["selected_pickup_target"] = null; // CanPickup is not the activity's current selection.
                targets.Add(target);
            }
            return new JObject {
                ["scope"] = radius.HasValue ? "nearby_loaded_pickables" : "observed_collect_objective_uids_in_loaded_scenes",
                ["query_status"] = player == null && radius.HasValue ? "player_unknown" : "sampled",
                ["coordinate_units"] = "unity_units", ["player"] = PlayerFrame(movement),
                ["camera_position_world"] = cameraPosition.HasValue ? WorldTargetProjection.Vector(cameraPosition.Value) : null,
                ["camera_forward_world"] = cameraForward.HasValue ? WorldTargetProjection.Vector(cameraForward.Value) : null,
                ["radius"] = radius.HasValue ? WorldTargetProjection.Number(radius.Value) : JValue.CreateNull(),
                ["targets"] = targets, ["targets_truncated"] = candidates.Length > limit,
                ["candidate_scan_truncated"] = scanTruncated, ["source_refresh_seconds"] = 1,
                ["coverage_note"] = "Loaded objects only. Empty output is not proof that a resource or unloaded location does not exist."
            };
        }

        public static JObject ReadSnapshot()
        {
            RefreshSources();
            var quests = ReadQuestState(manager);
            return new JObject {
                ["schema"] = "ocean-quest-world/1", ["frame"] = Time.frameCount,
                ["observed_unscaled_time"] = EditorApplication.timeSinceStartup,
                ["quests"] = quests, ["spatial"] = ReadSpatial(observedCollectUids, null, TargetLimit)
            };
        }

        // MCP may call this read-only method explicitly; it is not an additional native MCP tool.
        public static JObject ReadNearby(float radius = 30f, int limit = 32)
        {
            if (float.IsNaN(radius) || float.IsInfinity(radius) || radius <= 0 || radius > 200 || limit < 1 || limit > 64)
                throw new ArgumentOutOfRangeException("Use radius (0,200] unity units and limit1..64");
            RefreshSources();
            return ReadSpatial(null, radius, limit);
        }

        private static void Reset()
        {
            observedQuests.Clear(); observedCollectUids.Clear();
            observedQuestLimitReached = false; observedTargetLimitReached = false;
            lastQuest = null; lastSpatial = null;
            nextSampleAt = -1; lastEmitAt = -1; refreshAt = -1;
            manager = null; pickables = new Component[0];
        }

        internal static void InvalidateSources() { refreshAt = -1; manager = null; pickables = new Component[0]; }

        internal static void Begin() { Reset(); EmitSnapshot(true); }
        internal static void End(string reason) { EmitSnapshot(true); Reset(); }
        internal static void Sample() { EmitSnapshot(false); }

        private static void EmitSnapshot(bool force)
        {
            if (!DemoCapture.IsRecording || DemoCapture.Profile != "ocean-nomad-editor-v1") return;
            var now = EditorApplication.timeSinceStartup;
            if (!force && now < nextSampleAt) return;
            nextSampleAt = now + 0.2;
            var snapshot = ReadSnapshot();
            var quests = (JObject)snapshot["quests"];
            var spatial = (JObject)snapshot["spatial"];
            bool heartbeat = force || now - lastEmitAt >= 2;
            if (heartbeat || !JToken.DeepEquals(quests, lastQuest))
                DemoCapture.RecordModuleEvent("ocean.quest-world", "quest_snapshot", quests);
            if (heartbeat || !JToken.DeepEquals(spatial, lastSpatial))
                DemoCapture.RecordModuleEvent("ocean.quest-world", "spatial_snapshot", spatial);
            if (heartbeat) lastEmitAt = now;
            lastQuest = quests; lastSpatial = spatial;
        }
    }
}
#endif
