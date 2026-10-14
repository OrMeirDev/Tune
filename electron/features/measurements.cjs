// Taking measurements (plan PF02). Read only: nothing here changes the PC. Free space on the system
// drive, a short measurement of the PC at rest, and Windows' own start-up timing from its event log.
// What a measurement is and when two may be compared lives in domain/measurement-policy.cjs.
const fs = require('fs');
const os = require('os');
const { bootFacts, bootRecords, summarizeRest } = require('../domain/measurement-policy.cjs');
const { runPS } = require('../infra/powershell.cjs');
const { serviceCall } = require('../privilege/service.cjs');

// Free space on the system drive as the file system reports it (no PowerShell, so it is quick
// enough to take right before and right after a cleanup). null when it can't be read.
async function diskFree(drive = process.env.SystemDrive || 'C:') {
  try {
    const s = await fs.promises.statfs(`${drive}\\`);
    return { drive, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize), at: new Date().toISOString() };
  } catch {
    return null;
  }
}

// CPU time Windows counts per core, summed; the load between two calls is the share that wasn't idle.
// Kept separate from the live tiles' own counter so the two never shorten each other's interval.
const cpuTimes = () => os.cpus().reduce((a, c) => {
  const t = c.times;
  a.idle += t.idle;
  a.total += t.user + t.nice + t.sys + t.irq + t.idle;
  return a;
}, { idle: 0, total: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The PC at rest, with Tune open: CPU load, CPU temperature (from the service, when it is there) and
// memory in use, read every 2 seconds for `seconds`; the result is their medians, with the
// conditions they were taken under (see summarizeRest).
async function restMeasure({ seconds = 20, everyMs = 2000, onProgress, wait = sleep } = {}) {
  const at = new Date().toISOString();
  const n = Math.max(1, Math.round((seconds * 1000) / everyMs));
  const samples = [];
  let sensor = null;
  let prev = cpuTimes();
  for (let i = 0; i < n; i++) {
    await wait(everyMs);
    const cur = cpuTimes();
    const cpuLoad = cur.total > prev.total ? Math.round(100 * (1 - (cur.idle - prev.idle) / (cur.total - prev.total))) : null;
    prev = cur;
    const s = await serviceCall({ op: 'sensors' }, { timeoutMs: 1500 });
    const cpuTempC = s && s.ok && typeof s.data?.cpuTempC === 'number' ? s.data.cpuTempC : null;
    if (cpuTempC == null) sensor = !s ? 'noService' : (s.ok && s.data?.cpuNote) || 'noSensor';
    samples.push({ cpuLoad, cpuTempC, ramUsedBytes: os.totalmem() - os.freemem() });
    if (onProgress) onProgress({ phase: 'measure', percent: Math.round(((i + 1) / n) * 100) });
  }
  return { ok: true, data: summarizeRest(samples, { at, seconds, sensor }) };
}

// Windows' start-up records, read as the user:
// - Diagnostics-Performance event 100: how long each start took to the desktop and then until the PC
//   settled. Windows may keep this log to administrators; then the timing is "needs admin", never a
//   guess.
// - Kernel-Boot event 27: whether a start was a full one, a Fast Startup one or a resume from
//   hibernation.
// - Fast Startup and hibernation settings, and the system drive's media (SSD or hard disk).
const BOOT_PS = `
$types = @()
try { $types = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Boot'; Id = 27 } -MaxEvents 30 -ErrorAction Stop | ForEach-Object { @{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); code = [int]$_.Properties[0].Value } }) } catch {}
$num = { param($v) if ([string]$v -match '^\\d+$') { [int64]$v } else { $null } }
$timings = @(); $timingStatus = 'ok'
try {
  $timings = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100 } -MaxEvents 10 -ErrorAction Stop | ForEach-Object {
    $d = @{}; foreach ($n in ([xml]$_.ToXml()).Event.EventData.Data) { $d[[string]$n.Name] = [string]$n.'#text' }
    @{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); startedAt = $d['BootStartTime']; bootMs = (& $num $d['BootTime']); mainPathMs = (& $num $d['MainPathBootTime']); postBootMs = (& $num $d['BootPostBootTime']); startupApps = (& $num $d['BootNumStartupApps']) } })
} catch {
  $timingStatus = if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'none' }
    elseif ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException]) { 'needsAdmin' }
    else { 'unavailable' }
}
$hiberboot = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -ErrorAction SilentlyContinue).HiberbootEnabled
$hibernate = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power' -ErrorAction SilentlyContinue).HibernateEnabled
$media = $null; $bus = $null
try {
  $part = Get-Partition -DriveLetter ($env:SystemDrive.Substring(0, 1)) -ErrorAction Stop
  $pd = Get-PhysicalDisk -ErrorAction Stop | Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
  if ($pd) { $media = [string]$pd.MediaType; $bus = [string]$pd.BusType }
} catch {}
$result = @{ types = $types; timings = $timings; timingStatus = $timingStatus; hiberboot = $hiberboot; hibernate = $hibernate; media = $media; bus = $bus }`;

async function bootInfo() {
  const r = await runPS(BOOT_PS, { timeoutMs: 60000 });
  if (!r.ok) return r;
  const raw = r.data || {};
  return { ok: true, data: { ...bootFacts(raw), records: bootRecords({ timings: [].concat(raw.timings || []), types: [].concat(raw.types || []) }) } };
}

module.exports = { diskFree, restMeasure, bootInfo, BOOT_PS };
