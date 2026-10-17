// Live CPU/GPU readings (read only) and the CPU & memory page.
const os = require('os');
const { runPS } = require('../infra/powershell.cjs');
const { serviceCall } = require('../privilege/service.cjs');

// GPU temperature and fan speed straight from the Windows graphics kernel (the numbers Task
// Manager shows), so no extra driver is needed. CPU and coolant sensors are not reachable this way.
const GPU_TEMPS = `
$gpuTemps = @()
try {
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class TuneGpu {
  [StructLayout(LayoutKind.Sequential)] struct AdapterInfo { public uint hAdapter; public uint LuidLow; public int LuidHigh; public uint Sources; public int Precise; }
  [StructLayout(LayoutKind.Sequential)] struct Enum2 { public uint Count; public IntPtr Adapters; }
  [StructLayout(LayoutKind.Sequential)] struct Query { public uint hAdapter; public int Type; public IntPtr Data; public uint Size; }
  [StructLayout(LayoutKind.Sequential)] struct Close { public uint hAdapter; }
  [DllImport("gdi32.dll")] static extern int D3DKMTEnumAdapters2(ref Enum2 e);
  [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref Query q);
  [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref Close c);
  public static string[] Read() {
    var list = new List<string>();
    var e = new Enum2();
    if (D3DKMTEnumAdapters2(ref e) != 0 || e.Count == 0) return list.ToArray();
    int sz = Marshal.SizeOf(typeof(AdapterInfo));
    e.Adapters = Marshal.AllocHGlobal(sz * (int)e.Count);
    try {
      if (D3DKMTEnumAdapters2(ref e) != 0) return list.ToArray();
      for (int i = 0; i < e.Count; i++) {
        var a = (AdapterInfo)Marshal.PtrToStructure(e.Adapters + i * sz, typeof(AdapterInfo));
        IntPtr reg = Marshal.AllocHGlobal(2080), perf = Marshal.AllocHGlobal(64);
        try {
          for (int b = 0; b < 64; b++) Marshal.WriteByte(perf, b, 0);
          var q = new Query { hAdapter = a.hAdapter, Type = 8, Data = reg, Size = 2080 };       // adapter name
          var p = new Query { hAdapter = a.hAdapter, Type = 62, Data = perf, Size = 64 };       // performance data
          if (D3DKMTQueryAdapterInfo(ref q) == 0 && D3DKMTQueryAdapterInfo(ref p) == 0 && Marshal.ReadInt32(perf, 56) > 0)
            list.Add(Marshal.PtrToStringUni(reg) + "\\t" + (Marshal.ReadInt32(perf, 56) / 10.0) + "\\t" + Marshal.ReadInt32(perf, 48));
        } finally { Marshal.FreeHGlobal(reg); Marshal.FreeHGlobal(perf); var c = new Close { hAdapter = a.hAdapter }; D3DKMTCloseAdapter(ref c); }
      }
    } finally { Marshal.FreeHGlobal(e.Adapters); }
    return list.ToArray();
  }
}
'@
$gpuTemps = @([TuneGpu]::Read() | ForEach-Object { $p = $_ -split "\\t"; [pscustomobject]@{ name = $p[0]; tempC = [math]::Round([double]$p[1], [MidpointRounding]::AwayFromZero); fanRpm = [int]$p[2] } })
} catch {}`;

const perfPS = () => runPS(`
$os = Get-CimInstance Win32_OperatingSystem
$p1 = @{}; Get-Process | ForEach-Object { $p1[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds }
$load = (Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1).CounterSamples[0].CookedValue
$cores = [Environment]::ProcessorCount
$procs = @(Get-Process | Where-Object { $p1.ContainsKey($_.Id) } | ForEach-Object {
  [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; cpu = [math]::Round((($_.TotalProcessorTime.TotalMilliseconds - $p1[$_.Id]) / 1000 / $cores) * 100, 1); ramMB = [math]::Round($_.WorkingSet64 / 1MB) } })
$byName = $procs | Group-Object name | ForEach-Object { [pscustomobject]@{ name = $_.Name; cpu = [math]::Round(($_.Group | Measure-Object cpu -Sum).Sum, 1); ramMB = [int](($_.Group | Measure-Object ramMB -Sum).Sum); count = $_.Count } }
${GPU_TEMPS}
$result = @{ cpuLoad = [math]::Round($load); ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1); ramFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
  topCpu = @($byName | Sort-Object { $_.cpu } -Descending | Select-Object -First 6); topRam = @($byName | Sort-Object { $_.ramMB } -Descending | Select-Object -First 6)
  gpuTemps = $gpuTemps; cpuTempC = $null; liquidTempC = $null }`);

// The CPU readings from the service's answer: temperature, and (service 4 and later) package power,
// core voltage and the fastest core's clock.
const liveCpu = (s) => {
  const d = s && s.ok ? s.data : {};
  return {
    cpuTempC: d.cpuTempC ?? null,
    cpuPowerW: d.cpuPowerW ?? null,
    cpuVoltageV: d.cpuVoltageV ?? null,
    cpuClockMHz: d.cpuClockMHz ?? null,
    powerLimits: d.powerLimits ?? null,
    cpuNote: !s ? 'no service' : s.ok ? d.cpuNote : s.error,
  };
};

// CPU load since the previous call, from the time Windows counts per core (no extra process, so
// measuring it doesn't itself load the CPU). The first call has nothing to compare with.
let lastTimes = null;

function cpuLoadNow() {
  const sum = os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, total: 0 });
  const prev = lastTimes;
  lastTimes = sum;
  if (!prev || sum.total <= prev.total) return null;
  return Math.round(100 * (1 - (sum.idle - prev.idle) / (sum.total - prev.total)));
}

// Only the service's sensors (and the load and memory in use, which Windows tells any program):
// quick enough to refresh every couple of seconds while a page shows them.
async function sensors() {
  const load = cpuLoadNow();
  const ram = { ramUsedBytes: os.totalmem() - os.freemem(), ramTotalBytes: os.totalmem() };
  return { ok: true, data: { ...liveCpu(await serviceCall({ op: 'sensors' }, { timeoutMs: 5000 })), cpuLoad: load, ...ram } };
}

// Hardware sensors come from the background service (LibreHardwareMonitor); load, memory and the
// GPU temperature Windows itself reports work without it.
async function performance() {
  const [r, s] = await Promise.all([perfPS(), serviceCall({ op: 'sensors' }, { timeoutMs: 8000 })]);
  if (!r.ok) return r;
  const d = s && s.ok ? s.data : {};
  Object.assign(r.data, liveCpu(s));
  // The service also knows the GPU hot spot; keep Windows' reading when the service isn't there.
  if ([].concat(d.gpus || []).length) r.data.gpuTemps = [].concat(d.gpus).map((g, i) => ({ ...g, fanRpm: r.data.gpuTemps?.[i]?.fanRpm ?? null }));
  return r;
}

module.exports = { sensors, performance };
