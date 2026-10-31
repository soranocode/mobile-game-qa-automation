using System;
using System.Collections.Generic;

namespace GameQA.Agent
{
    // No Unity dependencies: exactly this scheduler is exercised by the offline tests.
    public interface IOperation
    {
        bool InputSent { get; }
        bool Complete { get; }
        string Outcome { get; }
        void Frame();
        void Release();
        object Evidence { get; }
    }

    public sealed class JobResult
    {
        public string request_id, status, reason;
        public bool input_sent;
        public int completed_steps;
        public double elapsed_seconds;
        public double first_input_seconds = -1;
        public readonly List<object> evidence = new List<object>();
    }

    public sealed class JobEngine
    {
        private sealed class Entry
        {
            public string fingerprint;
            public JobResult result;
        }
        private readonly Dictionary<string, Entry> requests = new Dictionary<string, Entry>();
        private readonly Func<double> now;
        private readonly Func<string> interruption;
        private Queue<Func<IOperation>> steps;
        private IOperation current;
        private JobResult active;
        private double started, deadline;
        private bool unverified;
        public bool Busy { get { return active != null && active.status == "running"; } }

        public JobEngine(Func<double> now, Func<string> interruption)
        {
            this.now = now;
            this.interruption = interruption;
        }

        public JobResult Start(string id, string fingerprint, IEnumerable<Func<IOperation>> factories, double timeout)
        {
            if (string.IsNullOrWhiteSpace(id) || id.Length > 100) throw new ArgumentException("invalid_request_id");
            Entry previous;
            if (requests.TryGetValue(id, out previous))
            {
                if (previous.fingerprint != fingerprint) throw new InvalidOperationException("request_id_conflict");
                return previous.result; // Same request never sends input twice, including after completion.
            }
            if (Busy) throw new InvalidOperationException("job_busy");
            if (requests.Count >= 64) throw new InvalidOperationException("session_request_limit");
            if (double.IsNaN(timeout) || double.IsInfinity(timeout) || timeout <= 0 || timeout > 60)
                throw new ArgumentException("invalid_timeout");
            var queue = new Queue<Func<IOperation>>(factories);
            if (queue.Count == 0 || queue.Count > 16) throw new ArgumentException("invalid_step_count");
            active = new JobResult { request_id = id, status = "running" };
            requests.Add(id, new Entry { fingerprint = fingerprint, result = active });
            steps = queue; current = null; unverified = false;
            started = now(); deadline = started + timeout;
            return active;
        }

        public JobResult Get(string id)
        {
            Entry entry;
            if (!requests.TryGetValue(id ?? "", out entry)) throw new ArgumentException("unknown_request");
            if (entry.result == active && Busy) entry.result.elapsed_seconds = Math.Max(0, now() - started);
            return entry.result;
        }

        public void Pump(bool gameFrame)
        {
            if (!Busy) return;
            try
            {
                var reason = interruption();
                if (reason != null) { Stop(reason); return; }
                if (now() >= deadline) { Stop("timeout"); return; }
                if (!gameFrame) return;
                if (current == null) current = steps.Dequeue()();
                current.Frame();
                RecordInput();
                if (!current.Complete) return;
                current.Release();
                active.evidence.Add(current.Evidence);
                var outcome = current.Outcome;
                current = null;
                if (outcome != "verified" && outcome != "input_sent") { Stop(outcome ?? "unknown_outcome"); return; }
                unverified |= outcome == "input_sent";
                active.completed_steps++;
                if (steps.Count == 0)
                {
                    active.status = unverified ? "needs_review" : "succeeded";
                    active.elapsed_seconds = Math.Max(0, now() - started);
                }
            }
            catch (Exception e) { Stop(e is InvalidOperationException ? e.Message : "operation_exception:" + e.GetType().Name); }
        }

        public void Stop(string reason)
        {
            if (!Busy) return;
            active.status = "stopped"; active.reason = reason;
            active.elapsed_seconds = Math.Max(0, now() - started);
            if (current != null)
            {
                RecordInput();
                try { current.Release(); }
                catch { active.reason += ":release_failed"; }
                try { active.evidence.Add(current.Evidence); }
                catch { /* Preserve the stop even if an evidence provider fails. */ }
            }
            current = null;
            steps.Clear();
        }

        private void RecordInput()
        {
            if (current == null || !current.InputSent) return;
            active.input_sent = true;
            if (active.first_input_seconds < 0) active.first_input_seconds = Math.Max(0, now() - started);
        }
    }
}
