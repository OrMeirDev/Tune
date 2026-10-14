// The fixed operations that need admin rights (PowerShell bodies), and the scripts they share. Both
// the background service and the admin session run exactly these; nothing else is ever elevated.
// Windows makes at most one restore point per 24 hours and only warns when it skips one. So the
// outcome is read from the restore points themselves: 'created' (a new one appeared), 'recent' (none
// was made, but one from the last 24 hours exists, verified by its date), or 'unavailable' (neither:
// System Protection is off or Windows declined). Never 'recent' without a point to go back to.
const restorePS = (label) => `
Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
$newest = { @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue) | Sort-Object SequenceNumber | Select-Object -Last 1 }
$before = (& $newest).SequenceNumber
Checkpoint-Computer -Description '${String(label).replace(/'/g, "''")}' -RestorePointType MODIFY_SETTINGS -WarningAction SilentlyContinue
$now = & $newest
$restore = if ($now -and $now.SequenceNumber -gt $before) { 'created' }
  elseif ($now -and [Management.ManagementDateTimeConverter]::ToDateTime($now.CreationTime) -gt (Get-Date).AddHours(-24)) { 'recent' }
  else { 'unavailable' }`;

// Windows Update only reports percentages to a callback object, so these empty COM callbacks
// exist just to be handed over; the script polls the job's progress itself.
const WU_CALLBACKS = `
if (-not ('TuneWuCallback' -as [type])) {
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[ComImport, Guid("8C3F1CDD-6173-4591-AEBD-A56A53CA77C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITuneDownloadProgress { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
[ComImport, Guid("77254866-9F5B-4C8E-B9E2-C77A8530D64B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITuneDownloadDone { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
[ComImport, Guid("E01402D5-F8DA-43BA-A012-38894BD048F1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITuneInstallProgress { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
[ComImport, Guid("45F4F6F3-D602-4F98-9A8A-3EFA152AD2D3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITuneInstallDone { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public class TuneWuCallback : ITuneDownloadProgress, ITuneDownloadDone, ITuneInstallProgress, ITuneInstallDone {
  void ITuneDownloadProgress.Invoke(object job, object args) {}
  void ITuneDownloadDone.Invoke(object job, object args) {}
  void ITuneInstallProgress.Invoke(object job, object args) {}
  void ITuneInstallDone.Invoke(object job, object args) {}
}
'@
}
$cb = New-Object TuneWuCallback`;

// Restore point first, then download and install the chosen Windows Update drivers.
// Progress: restore → download % → install %. If Windows refuses the asynchronous calls, it
// falls back to the plain ones (no percentages). Runs inside the admin session.
const DRIVERS_OP = `
$ids = @($req.ids | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^[0-9a-fA-F-]{36}$' })
if (-not $ids.Count) { throw 'no updates selected' }
Report-Progress @{ phase = 'restore' }
$restore = 'skipped'
try {${restorePS('Tune - before driver update')}
} catch { $restore = $_.Exception.Message }
Report-Progress @{ phase = 'prepare' }
$session = New-Object -ComObject Microsoft.Update.Session
$s = $session.CreateUpdateSearcher(); $s.ServerSelection = 2
$found = $s.Search("IsInstalled=0 and Type='Driver'")
$coll = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found.Updates) { if ($ids -contains $u.Identity.UpdateID) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$coll.Add($u) } }
if ($coll.Count -eq 0) { throw 'none of the selected updates are still offered' }
$cb = $null
try {${WU_CALLBACKS}
} catch { $cb = $null }
$dl = $session.CreateUpdateDownloader(); $dl.Updates = $coll
$job = $null; if ($cb) { try { $job = $dl.BeginDownload($cb, $cb, $null) } catch { $job = $null } }
if ($job) {
  while (-not $job.IsCompleted) { $p = $job.GetProgress(); Report-Progress @{ phase = 'download'; percent = [int]$p.PercentComplete; index = [int]$p.CurrentUpdateIndex + 1; count = $coll.Count }; Start-Sleep -Milliseconds 400 }
  [void]$dl.EndDownload($job)
} else { Report-Progress @{ phase = 'download'; count = $coll.Count }; [void]$dl.Download() }
Report-Progress @{ phase = 'download'; percent = 100; count = $coll.Count }
$inst = $session.CreateUpdateInstaller(); $inst.Updates = $coll
$ij = $null; if ($cb) { try { $ij = $inst.BeginInstall($cb, $cb, $null) } catch { $ij = $null } }
if ($ij) {
  while (-not $ij.IsCompleted) { $p = $ij.GetProgress(); Report-Progress @{ phase = 'install'; percent = [int]$p.PercentComplete; index = [int]$p.CurrentUpdateIndex + 1; count = $coll.Count }; Start-Sleep -Milliseconds 400 }
  $res = $inst.EndInstall($ij)
} else { Report-Progress @{ phase = 'install'; count = $coll.Count }; $res = $inst.Install() }
Report-Progress @{ phase = 'install'; percent = 100; count = $coll.Count }
$per = @(for ($i = 0; $i -lt $coll.Count; $i++) { @{ id = $coll.Item($i).Identity.UpdateID; code = [int]$res.GetUpdateResult($i).ResultCode } })
$result = @{ restore = $restore; reboot = [bool]$res.RebootRequired; results = $per }`;

// Only turns back on a device that Device Manager shows as disabled (code 22).
const ENABLE_OP = `
$dev = Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -eq [string]$req.id } | Select-Object -First 1
if (-not $dev -or $dev.ConfigManagerErrorCode -ne 22) { throw 'device is not disabled' }
Enable-PnpDevice -InstanceId $dev.PNPDeviceID -Confirm:$false
$result = 'enabled'`;

// Each category is a folder whose *contents* can go; files in use are skipped, never forced.
const JUNK = `
$cats = @(
  @{ key = 'userTemp'; paths = @($env:TEMP); admin = $false; minAgeHours = 24 }
  @{ key = 'winTemp'; paths = @("$env:SystemRoot\\Temp"); admin = $true; minAgeHours = 24 }
  @{ key = 'wuCache'; paths = @("$env:SystemRoot\\SoftwareDistribution\\Download"); admin = $true; minAgeHours = 24 }
  @{ key = 'browser'; paths = @("$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Cache", "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\Default\\Cache", "$env:LOCALAPPDATA\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Cache"); admin = $false }
  @{ key = 'thumbs'; paths = @("$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer"); filter = 'thumbcache_*.db'; admin = $false }
  @{ key = 'dumps'; paths = @("$env:SystemRoot\\Minidump", "$env:SystemRoot\\LiveKernelReports"); admin = $true }
  @{ key = 'appDumps'; paths = @("$env:LOCALAPPDATA\\CrashDumps"); admin = $false }
)
# Every file below a category's folder, without ever entering a junction or symbolic link: one of
# those inside a temp folder could lead anywhere on the disk. Linked files are left alone too.
function Under($root) {
  $todo = New-Object System.Collections.Generic.Stack[string]; $todo.Push($root)
  while ($todo.Count) {
    foreach ($i in @(Get-ChildItem -LiteralPath $todo.Pop() -Force -ErrorAction SilentlyContinue)) {
      if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if ($i.PSIsContainer) { $todo.Push($i.FullName) } else { $i } } } }
function Files($c) {
  # Temp folders: only files untouched for a day, so programs that are open right now keep theirs.
  $cutoff = if ($c.minAgeHours) { (Get-Date).AddHours(-$c.minAgeHours) } else { $null }
  foreach ($p in $c.paths) { if (Test-Path -LiteralPath $p) {
    $f = if ($c.filter) { Get-ChildItem -LiteralPath $p -Filter $c.filter -File -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } } else { Under $p }
    if ($cutoff) { $f | Where-Object { $_.LastWriteTime -lt $cutoff } } else { $f } } } }`;

// Only the fixed categories above can be cleaned, whatever keys arrive. Windows Update's download
// cache is left alone while Windows is installing or downloading updates (its workers are running).
const CLEAN_OP = `
$want = @($req.keys | ForEach-Object { [string]$_ }); $freed = [int64]0; $skipped = 0; $busy = @()
foreach ($c in $cats) { if ($want -notcontains $c.key) { continue }
  if ($c.key -eq 'wuCache' -and @(Get-Process -Name TiWorker, TrustedInstaller, MoUsoCoreWorker -ErrorAction SilentlyContinue).Count) { $busy += $c.key; continue }
  foreach ($f in @(Files $c)) { try { $len = $f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $freed += $len } catch { $skipped++ } } }
$result = @{ freed = $freed; skipped = $skipped; busy = $busy }`;

// Same switches Task Manager uses: StartupApproved values starting 02 = on, 03 = off.
const STARTUP = `
$src = @(
  @{ hive = 'HKCU'; run = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; approved = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' }
  @{ hive = 'HKLM'; run = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' }
  @{ hive = 'HKLM32'; run = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32' }
  @{ hive = 'HKCU-F'; folder = [Environment]::GetFolderPath('Startup'); approved = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' }
  @{ hive = 'HKLM-F'; folder = [Environment]::GetFolderPath('CommonStartup'); approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' }
)`;

// Only an existing machine-wide entry can be switched, and only between on and off.
const STARTUP_OP = `
$s = $src | Where-Object { $_.hive -like 'HKLM*' -and $_.hive -eq [string]$req.hive } | Select-Object -First 1
if (-not $s) { throw 'unknown startup source' }
$names = if ($s.run) { @((Get-Item $s.run).GetValueNames()) } else { @(Get-ChildItem $s.folder -File | ForEach-Object { $_.Name }) }
if ($names -notcontains [string]$req.key) { throw 'unknown startup entry' }
if (-not (Test-Path $s.approved)) { New-Item -Path $s.approved -Force | Out-Null }
$first = if ($req.enable -eq $true) { 2 } else { 3 }
Set-ItemProperty -Path $s.approved -Name ([string]$req.key) -Value ([byte[]]($first,0,0,0,0,0,0,0,0,0,0,0)) -Type Binary
$result = $(if ($req.enable -eq $true) { 'enabled' } else { 'disabled' })`;

const HAGS_OP = `
Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -Name HwSchMode -Value 2 -Type DWord
$result = 'reboot'`;

// The privileged operations, shared word for word by the admin session and the background service.
const OPS_TABLE = () => `
$ops = @{
  drivers = {${DRIVERS_OP}
  }
  enable = {${ENABLE_OP}
  }
  clean = {${CLEAN_OP}
  }
  startup = {${STARTUP_OP}
  }
  hags = {${HAGS_OP}
  }
  restore = {${restorePS('Tune - manual restore point')}
    $result = $restore
  }
}`;

module.exports = { JUNK, CLEAN_OP, STARTUP, OPS_TABLE };
