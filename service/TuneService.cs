// Tune Service: runs as LocalSystem so Tune can install drivers and change system settings
// without a UAC prompt each time, and reads the CPU and GPU temperatures through LibreHardwareMonitor
// (the CPU via the PawnIO driver).
//
// Safety model:
// - It lives in Program Files (only administrators can change its files).
// - Its named pipe accepts connections only from users signed in at this PC.
// - It runs only the fixed operations in ops.ps1 (next to this exe), which re-check every request.
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
        public const string Version = "3";
        // Another name only for testing a new build next to the installed service (--console --pipe X).
        static string PipeName = "TuneService";
        const int MaxRequest = 64 * 1024;
        static readonly HashSet<string> Operations = new HashSet<string> { "drivers", "enable", "clean", "startup", "hags", "restore" };

        readonly string dir = AppDomain.CurrentDomain.BaseDirectory;
        readonly object opLock = new object();
        volatile bool stopping;

        internal static void Start(string[] args)
        {
            if (args.Length > 0 && args[0] == "--console")
            {
                if (args.Length > 2 && args[1] == "--pipe") PipeName = args[2];
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
            for (int i = 0; i < 4; i++)
            {
                var t = new Thread(Listen);
                t.IsBackground = true;
                t.Start();
            }
        }

        protected override void OnStop()
        {
            stopping = true;
            for (int i = 0; i < 4; i++)
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
                        PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536, Security());
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
                    string line = ReadLine(pipe);
                    if (line == null) return;
                    var req = new JavaScriptSerializer().DeserializeObject(line) as Dictionary<string, object>;
                    string op = req != null && req.ContainsKey("op") ? Convert.ToString(req["op"]) : "";
                    if (op == "version") { Send(writer, Ok(Info())); return; }
                    if (op == "sensors") { Send(writer, Ok(Sensors())); return; }
                    if (!Operations.Contains(op)) { Send(writer, Fail("unknown request")); return; }
                    lock (opLock) { RunOperation(line, writer); }
                }
                catch (Exception e)
                {
                    Send(writer, Fail(e.Message));
                }
            }
        }

        static string ReadLine(Stream s)
        {
            var bytes = new List<byte>();
            int b;
            while ((b = s.ReadByte()) != -1)
            {
                if (b == '\n') break;
                if (bytes.Count >= MaxRequest) return null;
                bytes.Add((byte)b);
            }
            return bytes.Count == 0 ? null : Encoding.UTF8.GetString(bytes.ToArray());
        }

        // The request goes to ops.ps1 as base64 on the command line, so nothing passes through
        // files a normal user could touch. If Tune disconnects, the operation still finishes.
        void RunOperation(string line, StreamWriter writer)
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
            bool answered = false;
            using (var proc = Process.Start(psi))
            {
                proc.ErrorDataReceived += delegate { };
                proc.BeginErrorReadLine();
                string l;
                while ((l = proc.StandardOutput.ReadLine()) != null)
                {
                    if (l.StartsWith("PROGRESS ")) Send(writer, "{\"progress\":" + l.Substring(9) + "}");
                    else if (l.StartsWith("RESULT ")) { Send(writer, l.Substring(7)); answered = true; }
                }
                proc.WaitForExit();
            }
            if (!answered) Send(writer, Fail("operation ended without a result"));
        }

        static void Send(StreamWriter w, string json)
        {
            try { w.WriteLine(json); } catch (IOException) { } catch (ObjectDisposedException) { }
        }

        static string Ok(object data)
        {
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "ok", true }, { "data", data } });
        }

        static string Fail(string error)
        {
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "ok", false }, { "error", error } });
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
            r["gpus"] = gpus;
            return r;
        }
    }
}