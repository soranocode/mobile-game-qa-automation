#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Threading;

namespace QaDemonstrations
{
    // The worker touches files only; all Unity APIs stay on the main thread.
    internal sealed class JournalWriter
    {
        private readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
        private readonly AutoResetEvent signal = new AutoResetEvent(false);
        private readonly Thread worker;
        private readonly string path;
        private volatile bool closing;
        private long pendingBytes;
        private long written;
        public volatile string Error;
        public long Written { get { return Interlocked.Read(ref written); } }
        public long Accepted { get; private set; }
        public long PendingBytes { get { return Interlocked.Read(ref pendingBytes); } }

        public JournalWriter(string path)
        {
            this.path = path;
            worker = new Thread(WriteLoop) { IsBackground = true, Name = "QA demo journal" };
            worker.Start();
        }

        public bool Append(string line)
        {
            if (closing || Error != null) return false;
            int bytes = Encoding.UTF8.GetByteCount(line) + 1;
            if (Interlocked.Read(ref pendingBytes) + bytes > 4 * 1024 * 1024)
            {
                Error = "Writer queue exceeded 4 MiB; recording is incomplete";
                return false;
            }
            Interlocked.Add(ref pendingBytes, bytes);
            queue.Enqueue(line);
            Accepted++;
            signal.Set();
            return true;
        }

        public bool Finish()
        {
            closing = true;
            signal.Set();
            bool joined = worker.Join(3000);
            if (joined) signal.Dispose();
            return joined && Error == null && Written == Accepted;
        }

        private void WriteLoop()
        {
            try
            {
                using (var stream = new StreamWriter(path, false, new UTF8Encoding(false), 65536))
                {
                    var flushClock = System.Diagnostics.Stopwatch.StartNew();
                    while (!closing || !queue.IsEmpty)
                    {
                        string line;
                        while (queue.TryDequeue(out line))
                        {
                            stream.WriteLine(line);
                            Interlocked.Add(ref pendingBytes, -(Encoding.UTF8.GetByteCount(line) + 1));
                            Interlocked.Increment(ref written);
                        }
                        if (flushClock.ElapsedMilliseconds >= 1000)
                        {
                            stream.Flush();
                            flushClock.Restart();
                        }
                        if (!closing) signal.WaitOne(100);
                    }
                    stream.Flush();
                }
            }
            catch (Exception error)
            {
                Error = error.GetType().Name + ": " + error.Message;
            }
        }
    }
}
#endif
