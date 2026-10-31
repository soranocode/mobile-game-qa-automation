using System;
using GameQA.Agent;

internal static class JobEngineTests
{
    private sealed class Fake : IOperation
    {
        public bool InputSent { get; set; }
        public bool Complete { get; set; }
        public string Outcome { get; set; } = "verified";
        public int ticks, releases;
        public bool throwFrame, throwRelease;
        public object Evidence { get { return new { ticks, releases }; } }
        public void Frame() { ticks++; InputSent = true; if (throwFrame) throw new Exception("after input"); }
        public void Release() { releases++; if (throwRelease) throw new Exception("release failed"); }
    }
    private static int checks;
    private static void Check(bool ok, string name) { if (!ok) throw new Exception(name); checks++; }
    private static void Throws(Action action, string text)
    {
        try { action(); } catch (Exception e) { Check(e.Message == text, "expected " + text + ", got " + e.Message); return; }
        throw new Exception("Did not reject: " + text);
    }
    private static int Main()
    {
        double clock = 0;
        string interrupt = null;
        var engine = new JobEngine(() => clock, () => interrupt);
        var a = new Fake { Complete = true };
        var b = new Fake { Complete = true };
        var result = engine.Start("chain", "body", new Func<IOperation>[] { () => a, () => b }, 10);
        engine.Pump(false);
        Check(a.ticks == 0, "Editor watchdog must not send input");
        engine.Pump(true);
        Check(a.ticks == 1 && a.releases == 1 && b.ticks == 0 && result.status == "running", "ordered bounded steps");
        Check(result.first_input_seconds == 0, "first input latency recorded once");
        engine.Pump(true);
        Check(result.status == "succeeded" && result.completed_steps == 2 && result.input_sent, "verified effects");
        var same = engine.Start("chain", "body", new Func<IOperation>[] { () => throw new Exception("replay") }, 10);
        Check(object.ReferenceEquals(same, result) && a.ticks == 1, "completed request deduplication");
        Throws(() => engine.Start("chain", "other", new Func<IOperation>[] { () => a }, 10), "request_id_conflict");
        var finishedAt = result.elapsed_seconds; clock = 7;
        Check(engine.Get("chain").elapsed_seconds == finishedAt, "terminal timing must remain frozen");

        var sent = new Fake { Complete = true, Outcome = "input_sent" };
        var pending = engine.Start("no-proof", "a", new Func<IOperation>[] { () => sent }, 10);
        engine.Pump(true);
        Check(pending.status == "needs_review", "input is not QA success");
        var held = new Fake();
        var cancelled = engine.Start("cancel", "a", new Func<IOperation>[] { () => held, () => b }, 10);
        engine.Pump(true); engine.Stop("user_cancelled"); engine.Pump(true);
        Check(cancelled.status == "stopped" && cancelled.input_sent && held.releases == 1 && held.ticks == 1, "cancel releases and stops queue");
        engine.Stop("again"); Check(held.releases == 1, "repeated cancel is harmless");

        var afterInput = new Fake { throwFrame = true };
        var thrown = engine.Start("throw", "a", new Func<IOperation>[] { () => afterInput }, 10);
        engine.Pump(true);
        Check(thrown.status == "stopped" && thrown.input_sent && afterInput.releases == 1, "exception after sent input stays sent");
        var releaseFailure = new Fake { Complete = true, throwRelease = true };
        var broken = engine.Start("release", "a", new Func<IOperation>[] { () => releaseFailure, () => b }, 10);
        engine.Pump(true);
        Check(broken.status == "stopped" && broken.input_sent && !engine.Busy, "release failure stops pipeline");

        var blocked = new Fake();
        interrupt = "new_console_error";
        var error = engine.Start("error", "a", new Func<IOperation>[] { () => blocked }, 10);
        engine.Pump(true);
        Check(error.reason == interrupt && blocked.ticks == 0 && !error.input_sent, "error blocks next input");
        interrupt = null;
        var timeout = engine.Start("timeout", "a", new Func<IOperation>[] { () => blocked }, 2);
        engine.Pump(true); clock += 2; engine.Pump(false);
        Check(timeout.reason == "timeout" && blocked.releases == 1, "watchdog releases even without game frames");
        var running = engine.Start("busy", "a", new Func<IOperation>[] { () => new Fake() }, 2);
        Check(object.ReferenceEquals(running, engine.Start("busy", "a", new Func<IOperation>[] { () => b }, 2)), "running duplicate deduplicated");
        Throws(() => engine.Start("parallel", "a", new Func<IOperation>[] { () => b }, 2), "job_busy");
        engine.Stop("end");
        Throws(() => engine.Start("nan", "a", new Func<IOperation>[] { () => b }, double.NaN), "invalid_timeout");
        Throws(() => engine.Start("empty", "a", new Func<IOperation>[0], 2), "invalid_step_count");
        Throws(() => engine.Get("missing"), "unknown_request");
        {
            var bounded = new JobEngine(() => 0, () => null);
            // Fill without evicting previous IDs; arbitrary future replays cannot silently execute again.
            for (int j = 0; j < 64; j++) { bounded.Start(j.ToString(), "x", new Func<IOperation>[] { () => new Fake { Complete = true } }, 1); bounded.Pump(true); }
            Throws(() => bounded.Start("overflow", "x", new Func<IOperation>[] { () => b }, 1), "session_request_limit");
        }
        Console.WriteLine("JobEngine: " + checks + " checks passed; no Unity execution.");
        return 0;
    }
}
