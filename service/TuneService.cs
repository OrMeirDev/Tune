// Tune Service: runs as LocalSystem so Tune can install drivers and change system settings
// without a UAC prompt each time, and reads the CPU and GPU temperatures through LibreHardwareMonitor
// (the CPU via the PawnIO driver).
//
// Safety model:
// - It lives in its own folder in Program Files, which only administrators and SYSTEM can change
//   (the installer sets and checks that, and checks every file against the build's manifest).
// - Its named pipe accepts connections only from users signed in at this PC. Anyone of them may ask
//   the read-only questions (version, sensors); only a member of this PC's Administrators group may
//   ask for a change (audit TUN-01). A UAC-filtered administrator counts, so Tune needs no prompt for
//   them; a standard user is refused ("notAllowed") and Tune falls back to Windows' own prompt.
// - It runs only the fixed operations in ops.ps1 (next to this exe), which re-check every request.
// - Deadlines (audit TUN-06): a request line must arrive within 5 s; one change runs at a time (a second
//   one waits 2 s, then hears "busy"); each operation runs only inside a Windows job object, created
//   suspended and let run only once it is in the job (no job, no operation), and has a time limit,
//   after which it is ended together with every process it started and answered "timedOut". No other
//   change starts until Windows has confirmed that end.
//
// Built with the C# 5 compiler that ships with Windows (.NET Framework 4.8): scripts/build-service.cjs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using System.Linq;
using LibreHardwareMonitor.Hardware;

namespace Tune
{
    static class Program
    {
        // The sensor libraries sit next to the exe; load them from there even if a library asks for a
        // slightly different version of another. Set up before any type that uses them is touched.
        static void Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += delegate (object sender, ResolveEventArgs e)
            {
                string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(file) ? Assembly.LoadFrom(file) : null;
            };
            TuneService.Start(args);
        }
    }

    public class TuneService : ServiceBase
    {
        // From electron/privilege/service-version.cjs (scripts/build-service.cjs writes BuildInfo), the
        // same number the app expects, so the two can't drift.
        public const string Version = BuildInfo.Version;
        // Another name only for testing a new build next to the installed service (--console --pipe X).
        static string PipeName = "TuneService";
        const int MaxRequest = 64 * 1024;
        const int Listeners = 6;
        const int RequestDeadlineMs = 5000;
        const int OperationWaitMs = 2000;
        // The changes it can make, each with its time limit in minutes (longer than Tune itself waits).
        static readonly Dictionary<string, int> Operations = new Dictionary<string, int>
        {
            { "drivers", 35 }, { "enable", 5 }, { "clean", 15 }, { "startup", 2 }, { "hags", 2 }, { "restore", 10 },
        };
        // Console runs only (testing a build as yourself, never the installed service): a shorter limit.
        static int consoleOperationSeconds;

        readonly string dir = AppDomain.CurrentDomain.BaseDirectory;
        readonly object opLock = new object();
        volatile bool stopping;

        internal static void Start(string[] args)
        {
            if (args.Length > 0 && args[0] == "--console")
            {
                for (int i = 1; i + 1 < args.Length; i += 2)
                {
                    if (args[i] == "--pipe") PipeName = args[i + 1];
                    if (args[i] == "--op-seconds") consoleOperationSeconds = Math.Max(1, int.Parse(args[i + 1]));
#if TUNE_FAULTS
                    if (args[i] == "--fault")
                    {
                        string[] f = args[i + 1].Split(':');
                        fault = f[0];
                        if (f.Length > 1) faultTimes = int.Parse(f[1]);
                    }
#endif
                }
                var s = new TuneService();
                s.OnStart(null);
                Console.WriteLine("Tune Service running on \\\\.\\pipe\\" + PipeName + " - press Enter to stop");
                Console.ReadLine();
                s.OnStop();
                return;
            }
            Run(new TuneService());
        }

        public TuneService()
        {
            ServiceName = "TuneService";
            CanStop = true;
        }

        // Several listeners, so a new request never finds the pipe missing while another is served
        // (a driver install can keep one busy for minutes).
        protected override void OnStart(string[] args)
        {
            for (int i = 0; i < Listeners; i++)
            {
                var t = new Thread(Listen);
                t.IsBackground = true;
                t.Start();
            }
        }

        protected override void OnStop()
        {
            stopping = true;
            for (int i = 0; i < Listeners; i++)
                try { using (var c = new NamedPipeClientStream(".", PipeName)) c.Connect(300); } catch (Exception) { }
            lock (SensorLock) { if (computer != null) computer.Close(); computer = null; }
        }

        // SYSTEM and Administrators own the pipe (plus the account running it, which is SYSTEM when
        // installed); users signed in at this PC may talk to it. Nobody else can create an instance.
        static PipeSecurity Security()
        {
            var ps = new PipeSecurity();
            ps.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
            return ps;
        }

        void Listen()
        {
            while (!stopping)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, Security());
                    pipe.WaitForConnection();
                    if (stopping) { pipe.Dispose(); break; }
                    Serve(pipe);
                }
                catch (Exception)
                {
                    if (pipe != null) pipe.Dispose();
                    Thread.Sleep(500);
                }
            }
        }

        // One request per connection: a JSON line in; progress lines and then one result line out.
        void Serve(NamedPipeServerStream pipe)
        {
            using (pipe)
            {
                var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true);
                writer.AutoFlush = true;
                writer.NewLine = "\n";
                try
                {
                    string line = ReadLine(pipe, RequestDeadlineMs);
                    if (line == null) return;
                    var req = new JavaScriptSerializer().DeserializeObject(line) as Dictionary<string, object>;
                    string op = req != null && req.ContainsKey("op") ? Convert.ToString(req["op"]) : "";
                    if (op == "version") { Send(writer, Ok(Info())); return; }
                    if (op == "sensors") { Send(writer, Ok(Sensors())); return; }
                    if (!Operations.ContainsKey(op)) { Send(writer, Fail("unknown request", null)); return; }
                    if (!CallerIsAdministrator(pipe))
                    {
                        Send(writer, Fail("only an administrator of this PC can ask the Tune service to change it", "notAllowed"));
                        return;
                    }
                    if (!Monitor.TryEnter(opLock, OperationWaitMs))
                    {
                        Send(writer, Fail("another change is running; try again when it has finished", "busy"));
                        return;
                    }
                    try
                    {
                        string stillRunning = SettleUnconfirmed();
                        if (stillRunning != null) { Send(writer, Fail(stillRunning, "busy")); return; }
                        int limitMs = consoleOperationSeconds > 0 ? consoleOperationSeconds * 1000 : Operations[op] * 60 * 1000;
                        RunOperation(line, writer, limitMs);
                    }
                    finally { Monitor.Exit(opLock); }
                }
                catch (Exception e)
                {
                    Send(writer, Fail(e.Message, null));
                }
            }
        }

        // One line (up to MaxRequest bytes) within deadlineMs, or null: a client that connects and says
        // nothing, or never finishes its line, is dropped (disposing the pipe ends the pending read).
        static string ReadLine(Stream s, int deadlineMs)
        {
            var bytes = new List<byte>();
            var buf = new byte[4096];
            DateTime end = DateTime.UtcNow.AddMilliseconds(deadlineMs);
            while (true)
            {
                int left = (int)(end - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0) return null;
                IAsyncResult ar = s.BeginRead(buf, 0, buf.Length, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(left)) return null;
                int n = s.EndRead(ar);
                if (n <= 0) return null;
                for (int i = 0; i < n; i++)
                {
                    if (buf[i] == (byte)'\n') return bytes.Count == 0 ? null : Encoding.UTF8.GetString(bytes.ToArray());
                    if (bytes.Count >= MaxRequest) return null;
                    bytes.Add(buf[i]);
                }
            }
        }

        // ---------- who is asking (audit TUN-01) ----------

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returnLength);
        const int TokenGroupsClass = 2;
        static readonly SecurityIdentifier Administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

        // Whether the account at the other end of the pipe is a member of this PC's Administrators group:
        // in its token either enabled (elevated) or "deny only" (an administrator whose token UAC
        // filtered). Read while impersonating the client at the level it allowed; a client that allowed
        // nothing (anonymous) is not an administrator.
        static bool CallerIsAdministrator(NamedPipeServerStream pipe)
        {
            bool admin = false;
            try
            {
                pipe.RunAsClient(delegate
                {
                    using (var id = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
                        admin = !id.IsAnonymous && HasGroup(id.Token, Administrators);
                });
            }
            catch (Exception) { admin = false; }
            return admin;
        }

        // TOKEN_GROUPS: a count, then (SID pointer, attributes) pairs, each two pointers wide.
        static bool HasGroup(IntPtr token, SecurityIdentifier group)
        {
            int len;
            GetTokenInformation(token, TokenGroupsClass, IntPtr.Zero, 0, out len);
            if (len <= 0) return false;
            IntPtr buf = Marshal.AllocHGlobal(len);
            try
            {
                if (!GetTokenInformation(token, TokenGroupsClass, buf, len, out len)) return false;
                int count = Marshal.ReadInt32(buf);
                for (int i = 0; i < count; i++)
                {
                    IntPtr sid = Marshal.ReadIntPtr(buf, IntPtr.Size + i * IntPtr.Size * 2);
                    if (new SecurityIdentifier(sid) == group) return true;
                }
                return false;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        // ---------- running an operation, contained, with a deadline (audit TUN-06) ----------
        //
        // An operation runs only inside a Windows job object that ends every process in it when it is
        // terminated or closed. PowerShell is created suspended, put in the job, and only then let run,
        // so neither it nor a child it starts at once can ever be outside the job. If the job can't be
        // made or configured, or the process can't be put in it, the operation is not run at all (the
        // suspended process is ended; it never ran) and the answer says why ("containmentFailed").
        // At its limit the job is terminated, and the operation counts as stopped only when Windows
        // confirms it: the first process has exited and the job has no process left. Until an end is
        // confirmed no other change starts (it is tried again at the next request; meanwhile "busy").
        // Processes Windows starts on the operation's behalf through a service of its own (Windows
        // Installer, Windows Update) are not in the job; they are Windows' to finish.

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BasicAccounting info, int length, IntPtr returnLength);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
            bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic; public IoCounters Io;
            public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct BasicAccounting
        {
            public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo
        {
            public int Size; public string Reserved; public string Desktop; public string Title;
            public int X, Y, Width, Height, CountCharsX, CountCharsY, FillAttribute, Flags;
            public short ShowWindow, Reserved2Size; public IntPtr Reserved2;
            public IntPtr StdInput, StdOutput, StdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { public int Length; public IntPtr Descriptor; public bool Inherit; }

        const int JobObjectBasicAccountingInformation = 1;
        const int JobObjectBasicProcessIdList = 3;
        const int JobObjectExtendedLimitInformation = 9;
        const uint KillOnJobClose = 0x2000;
        const uint CreateSuspended = 0x4, CreateNoWindow = 0x08000000;
        const int UseStdHandles = 0x100;
        const uint HandleFlagInherit = 1, GenericRead = 0x80000000, GenericWrite = 0x40000000, ShareReadWrite = 3, OpenExisting = 3;
        const uint WaitObject0 = 0, NoResume = 0xFFFFFFFF;
        // how long an end is waited for before it counts as unconfirmed, and how long the rest of the
        // output is waited for
        const int ConfirmMs = 5000;
        const int OutputGraceMs = 5000;

#if TUNE_FAULTS
        // Test builds only (scripts/ci/service-containment-check.ps1 compiles one with /define:TUNE_FAULTS;
        // the shipped service has none of this): one native step made to fail, or the assignment
        // delayed, named by --fault on the console command line ("name", or "name:N" to fail only its
        // first N times). A step made to fail reports ERROR_INTERNAL_ERROR (1359), since Windows was
        // never asked.
        static string fault;
        static int faultTimes = -1;
        static bool Fault(string step)
        {
            if (fault != step) return false;
            if (faultTimes < 0) return true;
            if (faultTimes == 0) return false;
            faultTimes--;
            return true;
        }
        static void FaultDelay(string step) { if (fault == step) Thread.Sleep(3000); }
        static int ErrorOf(string step) { return fault == step ? 1359 : Marshal.GetLastWin32Error(); }
#else
        static bool Fault(string step) { return false; }
        static void FaultDelay(string step) { }
        static int ErrorOf(string step) { return Marshal.GetLastWin32Error(); }
#endif

        // One operation's processes: the job, the first process (PowerShell) and its main thread, and the
        // read end of its output until the reader takes it. Error is the last Windows error seen.
        sealed class Contained
        {
            public IntPtr Job, Process, Thread, Output;
            public bool InJob;
            public int Error;
            public void Close()
            {
                foreach (IntPtr h in new[] { Thread, Output, Process, Job }) if (h != IntPtr.Zero) CloseHandle(h);
                Thread = Output = Process = Job = IntPtr.Zero;
            }
        }

        sealed class OperationState { public bool Answered; public bool Closed; }

        // Operations whose end Windows hasn't confirmed. Only touched while opLock is held.
        readonly List<Contained> unconfirmed = new List<Contained>();

        static string Refused(string what, int error)
        {
            return "the change was not started: " + what + " (Windows error " + error + ")";
        }

        // Creates the job and, suspended, the operation's PowerShell, and puts it in the job. On any
        // failure whatever was made is undone and the reason returned; nothing of the operation ran.
        string Contain(string line, out Contained contained)
        {
            contained = null;
            var c = new Contained();
            IntPtr write = IntPtr.Zero, nul = IntPtr.Zero;
            try
            {
                c.Job = Fault("create-job") ? IntPtr.Zero : CreateJobObject(IntPtr.Zero, null);
                if (c.Job == IntPtr.Zero) return Refused("Windows could not create a job object to contain it", ErrorOf("create-job"));
                var limits = new ExtendedLimits();
                limits.Basic.LimitFlags = KillOnJobClose;
                if (Fault("configure-job") || !SetInformationJobObject(c.Job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
                    return Refused("Windows could not configure the job object to end its processes", ErrorOf("configure-job"));

                var inherit = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
                IntPtr read;
                if (!CreatePipe(out read, out write, ref inherit, 0)) return Refused("Windows could not create its output pipe", Marshal.GetLastWin32Error());
                c.Output = read;
                if (!SetHandleInformation(read, HandleFlagInherit, 0)) return Refused("Windows could not keep its output pipe private", Marshal.GetLastWin32Error());
                nul = CreateFile("NUL", GenericRead | GenericWrite, ShareReadWrite, ref inherit, OpenExisting, 0, IntPtr.Zero);
                if (nul == new IntPtr(-1)) { nul = IntPtr.Zero; return Refused("Windows could not open NUL for it", Marshal.GetLastWin32Error()); }

                string ps = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
                var command = new StringBuilder("\"" + ps + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(dir, "ops.ps1") +
                    "\" -Request " + Convert.ToBase64String(Encoding.UTF8.GetBytes(line)));
                var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = UseStdHandles, StdInput = nul, StdOutput = write, StdError = nul };
                ProcessInformation info;
                if (!CreateProcess(ps, command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | CreateNoWindow, IntPtr.Zero, null, ref startup, out info))
                    return Refused("Windows could not start PowerShell", Marshal.GetLastWin32Error());
                c.Process = info.Process;
                c.Thread = info.Thread;

                FaultDelay("delay-assign");
                if (Fault("assign") || !AssignProcessToJobObject(c.Job, c.Process))
                {
                    int error = ErrorOf("assign");
                    // never resumed, so nothing of it ran; it is ended (and that confirmed) before the answer
                    if (!EndAll(c)) { Remember(c); c = null; }
                    return Refused("Windows could not put it in a job object", error);
                }
                c.InJob = true;
                contained = c;
                c = null;
                return null;
            }
            finally
            {
                // this process's copies of the child's ends: the child (and only it) keeps its own
                if (write != IntPtr.Zero) CloseHandle(write);
                if (nul != IntPtr.Zero) CloseHandle(nul);
                if (c != null) c.Close();
            }
        }

        static int ActiveProcesses(IntPtr job)
        {
            BasicAccounting a;
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out a, Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero)) return -1;
            return (int)a.ActiveProcesses;
        }

        // The ids of the processes still in the job (for the answer when an end isn't confirmed), or "?".
        static string JobProcessIds(IntPtr job)
        {
            const int most = 64;
            int size = 8 + most * IntPtr.Size;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                // ERROR_MORE_DATA (234) still fills in the first ones
                if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf, size, IntPtr.Zero) && Marshal.GetLastWin32Error() != 234) return "?";
                int listed = Math.Min(Marshal.ReadInt32(buf, 4), most);
                var ids = new List<string>();
                for (int i = 0; i < listed; i++) ids.Add(Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64().ToString());
                return ids.Count == 0 ? "none" : string.Join(", ", ids.ToArray());
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        static string StillRunning(Contained c)
        {
            return "Windows error " + c.Error + "; " + (Exited(c.Process) ? "" : "its first process still runs; ") +
                "processes still in its job: " + (c.InJob ? JobProcessIds(c.Job) : "not in a job");
        }

        static bool Exited(IntPtr process)
        {
            return process == IntPtr.Zero || WaitForSingleObject(process, 0) == WaitObject0;
        }

        static bool Ended(Contained c)
        {
            return Exited(c.Process) && (!c.InJob || ActiveProcesses(c.Job) == 0);
        }

        // Ends every process of the operation and confirms it within ConfirmMs: true only when the first
        // process has exited and the job has none left. A refusal is kept in c.Error.
        static bool EndAll(Contained c)
        {
            if (Ended(c)) return true;
            bool asked = Fault("terminate") ? false : c.InJob ? TerminateJobObject(c.Job, 1) : TerminateProcess(c.Process, 1);
            if (!asked) c.Error = ErrorOf("terminate");
            DateTime end = DateTime.UtcNow.AddMilliseconds(ConfirmMs);
            while (!Ended(c))
            {
                if (DateTime.UtcNow >= end) return false;
                Thread.Sleep(100);
            }
            return true;
        }

        void Remember(Contained c)
        {
            unconfirmed.Add(c);
        }

        // Before a change: an earlier operation whose end wasn't confirmed is ended again; while any is
        // left, the answer is the reason no change can start (null when none is left).
        string SettleUnconfirmed()
        {
            for (int i = unconfirmed.Count - 1; i >= 0; i--)
            {
                if (EndAll(unconfirmed[i])) { unconfirmed[i].Close(); unconfirmed.RemoveAt(i); }
            }
            return unconfirmed.Count == 0 ? null
                : "an earlier change has not been confirmed as stopped (" + StillRunning(unconfirmed[0]) + "); no other change starts until it is";
        }

        // Reads the operation's output: progress lines and its result go to Tune as they come, until the
        // answer for this request is closed.
        static Thread StartReader(Contained c, StreamWriter writer, OperationState state)
        {
            var stream = new FileStream(new SafeFileHandle(c.Output, true), FileAccess.Read, 4096, false);
            c.Output = IntPtr.Zero; // the stream owns it now
            var t = new Thread(delegate ()
            {
                try
                {
                    using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
                    {
                        string l;
                        while ((l = reader.ReadLine()) != null)
                        {
                            lock (state)
                            {
                                if (state.Closed) return;
                                if (l.StartsWith("PROGRESS ")) Send(writer, "{\"progress\":" + l.Substring(9) + "}");
                                else if (l.StartsWith("RESULT ")) { Send(writer, l.Substring(7)); state.Answered = true; }
                            }
                        }
                    }
                }
                catch (Exception) { }
            });
            t.IsBackground = true;
            t.Start();
            return t;
        }

        // The request goes to ops.ps1 as base64 on the command line, so nothing passes through files a
        // normal user could touch. If Tune disconnects, the operation still finishes, unless it runs past
        // its limit: then it is ended with everything it started, and answered "timedOut" (with
        // "stopped": false when Windows hasn't confirmed that yet).
        void RunOperation(string line, StreamWriter writer, int limitMs)
        {
            Contained c;
            string refused = Contain(line, out c);
            if (refused != null) { Send(writer, Fail(refused, "containmentFailed")); return; }
            var state = new OperationState();
            Thread reader = null;
            bool ended = false;
            string answer = null;
            try
            {
                reader = StartReader(c, writer, state);
                if (Fault("resume") || ResumeThread(c.Thread) == NoResume)
                {
                    c.Error = ErrorOf("resume");
                    ended = EndAll(c);
                    answer = Fail(Refused("Windows could not let it run", c.Error), "containmentFailed");
                    return;
                }
                bool finished = WaitForSingleObject(c.Process, (uint)limitMs) == WaitObject0;
                if (finished) reader.Join(OutputGraceMs);
                // anything it left running ends with the job; past its limit, everything does
                ended = EndAll(c);
                reader.Join(OutputGraceMs);
                if (finished) answer = Fail("operation ended without a result", null);
                else if (ended) answer = Fail("the operation did not finish in time and was stopped", "timedOut");
                else answer = Fail("the operation did not finish in time; Windows has not confirmed that it stopped (" + StillRunning(c) +
                    "), so no other change starts until it has", "timedOut", false);
            }
            catch (Exception e)
            {
                ended = EndAll(c);
                answer = Fail("the operation failed: " + e.Message, null);
            }
            finally
            {
                bool answered;
                lock (state) { state.Closed = true; answered = state.Answered; }
                if (!answered && answer != null) Send(writer, answer);
                if (ended) c.Close(); else Remember(c);
            }
        }

        // Lines from the operation's output thread and from this one never interleave.
        static void Send(StreamWriter w, string json)
        {
            lock (w)
            {
                try { w.WriteLine(json); } catch (IOException) { } catch (ObjectDisposedException) { } catch (InvalidOperationException) { }
            }
        }

        static string Ok(object data)
        {
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "ok", true }, { "data", data } });
        }

        static string Fail(string error, string code)
        {
            var r = new Dictionary<string, object> { { "ok", false }, { "error", error } };
            if (code != null) r["code"] = code;
            return new JavaScriptSerializer().Serialize(r);
        }

        static string Fail(string error, string code, bool stopped)
        {
            var r = new Dictionary<string, object> { { "ok", false }, { "error", error }, { "code", code }, { "stopped", stopped } };
            return new JavaScriptSerializer().Serialize(r);
        }

        static string PawnIoVersion()
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (var k = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO"))
                {
                    if (k != null && k.GetValue("DisplayVersion") != null) return Convert.ToString(k.GetValue("DisplayVersion"));
                }
            }
            return null;
        }

        static string CpuVendor()
        {
            using (var k = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0"))
                return k == null ? "" : Convert.ToString(k.GetValue("VendorIdentifier"));
        }

        Dictionary<string, object> Info()
        {
            return new Dictionary<string, object> { { "version", Version }, { "pawnio", PawnIoVersion() }, { "cpuVendor", CpuVendor() } };
        }

        // ---------- sensors (LibreHardwareMonitor) ----------

        // One Computer stays open for the life of the service; each request refreshes it. Only the CPU
        // (through the PawnIO driver) and the GPUs are read; coolers, boards and power supplies are not touched.
        static readonly object SensorLock = new object();
        static Computer computer;

        static Computer Hw()
        {
            if (computer == null)
            {
                var c = new Computer { IsCpuEnabled = true, IsGpuEnabled = true };
                c.Open();
                computer = c;
            }
            return computer;
        }

        static IEnumerable<IHardware> All(IEnumerable<IHardware> list)
        {
            foreach (var h in list)
            {
                yield return h;
                foreach (var s in All(h.SubHardware)) yield return s;
            }
        }

        static IEnumerable<ISensor> Temps(IHardware h)
        {
            foreach (var s in h.Sensors)
                if (s.SensorType == SensorType.Temperature && s.Value.HasValue && s.Value.Value > 0 && s.Value.Value < 150) yield return s;
        }

        static object Round(float v) { return Math.Round(v, 0); }

        static ISensor Find(IHardware h, SensorType type, Func<ISensor, bool> match)
        {
            foreach (var s in h.Sensors)
                if (s.SensorType == type && s.Value.HasValue && match(s)) return s;
            return null;
        }

        // Power, voltage and clock of the CPU, read only. Intel: "CPU Package" power and the "CPU Core"
        // voltage the processor reports; AMD: "Package" power and the SVI2/SVI3 core voltage. The clock
        // is the fastest core right now.
        static void CpuLive(IHardware h, Dictionary<string, object> r)
        {
            var power = Find(h, SensorType.Power, s => s.Name.Contains("Package"));
            if (power != null && power.Value.Value > 0 && power.Value.Value < 1000) r["cpuPowerW"] = Round(power.Value.Value);
            var volt = Find(h, SensorType.Voltage, s => s.Name == "CPU Core")
                ?? Find(h, SensorType.Voltage, s => s.Name.Contains("SVI") && s.Name.StartsWith("Core"));
            if (volt == null)
                foreach (var s in h.Sensors)
                    if (s.SensorType == SensorType.Voltage && s.Value.HasValue && s.Name.Contains("VID") && (volt == null || s.Value.Value > volt.Value.Value)) volt = s;
            if (volt != null && volt.Value.Value > 0.3 && volt.Value.Value < 2.0) r["cpuVoltageV"] = Math.Round(volt.Value.Value, 3);
            float clock = 0;
            foreach (var s in h.Sensors)
                if (s.SensorType == SensorType.Clock && s.Value.HasValue && s.Name.Contains("Core") && s.Value.Value > clock && s.Value.Value < 10000) clock = s.Value.Value;
            if (clock > 0) r["cpuClockMHz"] = Round(clock);
        }

        // ---------- power limits (Intel, read only) ----------
        // The package power limits the BIOS set (PL1 = long-term, PL2 = short boost), read from the
        // processor: MSR 0x606 holds the units, MSR 0x610 the limits. Nothing is ever written. They only
        // change with a BIOS setting, so one reading a minute is plenty.
        static Dictionary<string, object> limitsCache;
        static DateTime limitsAt = DateTime.MinValue;

        static Dictionary<string, object> PowerLimits()
        {
            if (CpuVendor() != "GenuineIntel") return null;
            if ((DateTime.UtcNow - limitsAt).TotalSeconds < 60) return limitsCache;
            limitsAt = DateTime.UtcNow;
            limitsCache = null;
            try
            {
                var msr = new LibreHardwareMonitor.PawnIo.IntelMsr();
                try
                {
                    ulong units, lim;
                    if (!msr.ReadMsr(0x606, out units) || !msr.ReadMsr(0x610, out lim)) return null;
                    double pu = 1.0 / Math.Pow(2, (int)(units & 0xF));
                    limitsCache = new Dictionary<string, object> {
                        { "pl1W", Math.Round((lim & 0x7FFF) * pu, 1) },
                        { "pl1On", ((lim >> 15) & 1) == 1 },
                        { "pl2W", Math.Round(((lim >> 32) & 0x7FFF) * pu, 1) },
                        { "pl2On", ((lim >> 47) & 1) == 1 },
                    };
                }
                finally { msr.Close(); }
            }
            catch (Exception) { limitsCache = null; }
            return limitsCache;
        }

        Dictionary<string, object> Sensors()
        {
            var r = new Dictionary<string, object> { { "pawnio", PawnIoVersion() } };
            var gpus = new List<object>();
            lock (SensorLock)
            {
                var hw = All(Hw().Hardware).ToList();
                foreach (var h in Hw().Hardware) h.Update();
                foreach (var h in hw)
                {
                    var temps = Temps(h).ToList();
                    if (h.HardwareType == HardwareType.Cpu && !r.ContainsKey("cpuTempC") && temps.Count > 0)
                    {
                        // Intel: "CPU Package"; AMD: "Core (Tctl/Tdie)"; otherwise the hottest core.
                        var pick = temps.FirstOrDefault(s => s.Name.Contains("Package") || s.Name.Contains("Tctl") || s.Name.Contains("Tdie"))
                            ?? temps.OrderByDescending(s => s.Value.Value).First();
                        r["cpuTempC"] = Round(pick.Value.Value);
                        r["cpuName"] = h.Name;
                        CpuLive(h, r);
                    }
                    if (h.HardwareType == HardwareType.GpuNvidia || h.HardwareType == HardwareType.GpuAmd || h.HardwareType == HardwareType.GpuIntel)
                    {
                        var core = temps.FirstOrDefault(s => s.Name == "GPU Core") ?? temps.FirstOrDefault();
                        var hot = temps.FirstOrDefault(s => s.Name.Contains("Hot Spot"));
                        if (core != null) gpus.Add(new Dictionary<string, object> { { "name", h.Name }, { "tempC", Round(core.Value.Value) }, { "hotspotC", hot == null ? null : Round(hot.Value.Value) } });
                    }
                }
            }
            if (!r.ContainsKey("cpuTempC")) r["cpuNote"] = PawnIoVersion() == null ? "pawnio not installed" : "no reading";
            var limits = PowerLimits();
            if (limits != null) r["powerLimits"] = limits;
            r["gpus"] = gpus;
            return r;
        }
    }
}