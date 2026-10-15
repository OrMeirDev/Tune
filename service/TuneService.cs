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
//   one waits 2 s, then hears "busy"); each operation has a time limit, after which it is ended
//   together with every process it started (a Windows job object) and answered "timedOut".
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

        // ---------- running an operation, with a deadline (audit TUN-06) ----------

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
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
        const int JobObjectExtendedLimitInformation = 9;
        const uint KillOnJobClose = 0x2000;

        // A job whose processes all end when it is closed or terminated (IntPtr.Zero if Windows refused).
        static IntPtr NewKillJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimits))))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }

        sealed class OperationState { public volatile bool Answered; }

        // The request goes to ops.ps1 as base64 on the command line, so nothing passes through
        // files a normal user could touch. If Tune disconnects, the operation still finishes, unless it
        // runs past its limit: then it is ended with everything it started, and answered "timedOut".
        void RunOperation(string line, StreamWriter writer, int limitMs)
        {
            string ps = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string script = Path.Combine(dir, "ops.ps1");
            var psi = new ProcessStartInfo(ps, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -Request " +
                Convert.ToBase64String(Encoding.UTF8.GetBytes(line)));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            var state = new OperationState();
            IntPtr job = NewKillJob();
            try
            {
                using (var proc = new Process())
                {
                    proc.StartInfo = psi;
                    proc.OutputDataReceived += delegate (object sender, DataReceivedEventArgs e)
                    {
                        string l = e.Data;
                        if (l == null) return;
                        if (l.StartsWith("PROGRESS ")) Send(writer, "{\"progress\":" + l.Substring(9) + "}");
                        else if (l.StartsWith("RESULT ")) { Send(writer, l.Substring(7)); state.Answered = true; }
                    };
                    proc.ErrorDataReceived += delegate { };
                    proc.Start();
                    if (job != IntPtr.Zero) AssignProcessToJobObject(job, proc.Handle);
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();
                    if (!proc.WaitForExit(limitMs))
                    {
                        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
                        else try { proc.Kill(); } catch (Exception) { }
                        proc.WaitForExit(5000);
                        if (!state.Answered) Send(writer, Fail("the operation did not finish in time and was stopped", "timedOut"));
                        return;
                    }
                    proc.WaitForExit(); // the rest of its output
                }
            }
            finally { if (job != IntPtr.Zero) CloseHandle(job); }
            if (!state.Answered) Send(writer, Fail("operation ended without a result", null));
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