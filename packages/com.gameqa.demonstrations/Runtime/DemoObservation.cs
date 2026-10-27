#if UNITY_EDITOR
using System;
using System.Collections.Generic;

namespace QaDemonstrations
{
    public static class RecorderPackage
    {
        public const string Name = "com.gameqa.demonstrations";
        public const string Version = "0.2.0";
    }

    // Providers read existing game state. They must not create services or invoke game actions.
    public interface IDemoObservationProvider
    {
        string ProfileId { get; }
        string SpaceJumpBinding { get; }
        bool IsAvailable();
        object Read();
        bool TryGrounded(out bool grounded);
        void Invalidate();
    }

    public static class DemoObservation
    {
        private static readonly List<IDemoObservationProvider> providers = new List<IDemoObservationProvider>();
        private static IDemoObservationProvider active;
        public static string ProfileId { get { return active == null ? "unity-editor-generic-v1" : active.ProfileId; } }
        public static string SpaceJumpBinding { get { return active == null ? "unknown; game adapter required" : active.SpaceJumpBinding; } }

        public static void Register(IDemoObservationProvider provider)
        {
            if (provider == null || string.IsNullOrWhiteSpace(provider.ProfileId)) throw new ArgumentException("Provider ID is required");
            if (DemoCapture.IsRecording) throw new InvalidOperationException("Do not change providers during recording");
            foreach (var existing in providers)
                if (existing.ProfileId == provider.ProfileId) throw new ArgumentException("Duplicate observation profile: " + provider.ProfileId);
            providers.Add(provider);
        }

        internal static void SelectForSession()
        {
            active = null;
            foreach (var provider in providers)
            {
                if (!provider.IsAvailable()) continue;
                if (active != null) throw new InvalidOperationException("Multiple observation providers match; resolve ambiguity before recording");
                active = provider;
            }
            Invalidate();
        }

        internal static object Read()
        {
            if (active != null) return active.Read();
            return new { player = (object)null, camera = (object)null, game_signals = (object)null, coordinate_units = "unity_units" };
        }

        internal static bool TryGrounded(out bool grounded)
        {
            grounded = false;
            return active != null && active.TryGrounded(out grounded);
        }

        internal static void Invalidate() { if (active != null) active.Invalidate(); }
    }
}
#endif
