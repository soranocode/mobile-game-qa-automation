#if UNITY_EDITOR
using System;
using UnityEditor;

namespace QaDemonstrations
{
    [InitializeOnLoad]
    internal static class OceanNomadProviderRegistration
    {
        static OceanNomadProviderRegistration() { DemoObservation.Register(new OceanNomadProvider()); }
    }

    // Reflection keeps the package independent of the game's assemblies and private sources.
    internal sealed class OceanNomadProvider : IDemoObservationProvider
    {
        public string ProfileId { get { return "ocean-nomad-editor-v1"; } }
        public string SpaceJumpBinding { get { return "human confirmed 2026-10-21; Jump axis also observed"; } }
        public bool IsAvailable()
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                if (assembly.GetType("Survival.Views.Movement", false) != null) return true;
            return false;
        }
        public object Read() { return OceanNomadObservation.Read(); }
        public bool TryGrounded(out bool grounded) { return OceanNomadObservation.TryGrounded(out grounded); }
        public void Invalidate() { OceanNomadObservation.Invalidate(); OceanNomadTelemetry.InvalidateSources(); }
    }
}
#endif
