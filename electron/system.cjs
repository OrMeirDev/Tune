// Everything Tune asks of Windows goes through PowerShell scripts that print JSON.
// Read-only work runs as the user; anything that needs admin rights goes through the admin
// session further down (one UAC prompt covers the next 10 minutes; never at startup).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { oemBios, searchPage, BIOS_SOURCES } = require('./oem-bios.cjs');

const PS =path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PRELUDE = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;\n";

function tempFile(ext) {
  return path.join(os.tmpdir(), `tune-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

const cmpVer = (a, b) => {
  const x = String(a || '').split('.').map(Number);
  const y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

// Runs `body` (PowerShell that leaves its result in $result) as the user and returns the parsed JSON.
function runPS(body, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const out = tempFile('json');
  const script = tempFile('ps1');
  const full = `${PRELUDE}try {\n${body}\n$payload = @{ ok = $true; data = $result } } catch { $payload = @{ ok = $false; error = $_.Exception.Message } }\n` +
    `[IO.File]::WriteAllText('${out}', ($payload | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding $false))`;
  fs.writeFileSync(script, '\ufeff' + full, 'utf8'); // BOM so Windows PowerShell 5.1 reads Hebrew/UTF-8 correctly
  return new Promise((resolve) => {
    const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\ufeff/, ''));
      } catch {
        res = { ok: false, error: `no result (exit ${code})` };
      }
      fs.rm(out, { force: true }, () => {});
      fs.rm(script, { force: true }, () => {});
      resolve(res);
    });
  });
}

// ---------------- hardware ----------------

const scanHardware = () => runPS(`
$cs = Get-CimInstance Win32_ComputerSystem; $bb = Get-CimInstance Win32_BaseBoard; $bios = Get-CimInstance Win32_BIOS
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; driverVersion = $_.DriverVersion; pnp = $_.PNPDeviceID } })
$devices = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and $_.DriverVersion } | ForEach-Object {
  @{ name = $_.DeviceName; cls = $_.DeviceClass; maker = $_.Manufacturer; provider = $_.DriverProviderName; version = $_.DriverVersion;
     date = $(if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }); hwid = $_.HardWareID; id = $_.DeviceID } })
$problems = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -ne 0 } | ForEach-Object { @{ name = $_.Name; code = [int]$_.ConfigManagerErrorCode; id = $_.PNPDeviceID } })
# AMD's site names releases by the "AMD Software" package version (26.8.1), not the driver's 32.0.x number.
$amdSw = (Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^AMD Software' } | Select-Object -First 1).DisplayVersion
$result = @{
  amdSoftware = $amdSw
  systemMaker = $cs.Manufacturer; systemModel = $cs.Model; systemSku = $cs.SystemSKUNumber
  computer = "$($cs.Manufacturer) $($cs.Model)".Trim(); board = "$($bb.Manufacturer) $($bb.Product)".Trim(); boardMaker = $bb.Manufacturer; boardModel = $bb.Product
  bios = @{ version = $bios.SMBIOSBIOSVersion; date = $bios.ReleaseDate.ToString('yyyy-MM-dd') }
  cpu = $cpu.Name.Trim(); ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB); gpus = $gpus; devices = $devices; problems = $problems
}`);

// ---------------- drivers ----------------

// Windows Update's driver catalog: drivers manufacturers publish to Microsoft, already matched to
// this PC's exact hardware IDs by Windows itself.
const driverUpdates = () => runPS(`
$s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $s.ServerSelection = 2
$r = $s.Search("IsInstalled=0 and Type='Driver'")
$result = @(foreach ($u in $r.Updates) { @{
  id = $u.Identity.UpdateID; title = $u.Title; model = $u.DriverModel; maker = $u.DriverManufacturer; cls = $u.DriverClass
  hwid = $u.DriverHardwareID; date = $(if ($u.DriverVerDate) { $u.DriverVerDate.ToString('yyyy-MM-dd') } else { $null })
  size = [int64]$u.MaxDownloadSize; reboot = [bool]$u.InstallationBehavior.RebootBehavior } })`, { timeoutMs: 5 * 60 * 1000 });

// Windows makes at most one restore point per 24 hours and only warns when it skips one, so
// compare sequence numbers: $restore ends up 'created', or 'recent' when a point from today exists.
const restorePS = (label) => `
Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
$seq = { (@(Get-ComputerRestorePoint -ErrorAction SilentlyContinue) | Measure-Object -Property SequenceNumber -Maximum).Maximum }
$before = & $seq
Checkpoint-Computer -Description '${String(label).replace(/'/g, "''")}' -RestorePointType MODIFY_SETTINGS -WarningAction SilentlyContinue
$restore = if ((& $seq) -gt $before) { 'created' } else { 'recent' }`;

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

const installDrivers = (ids, onProgress) => privileged({ op: 'drivers', ids }, { timeoutMs: 30 * 60 * 1000, onProgress });

// Streams a download to disk with progress and an optional SHA-256 check; a failed or
// mismatched file is removed rather than left half-written.
async function downloadFile(url, file, { headers = {}, sha256, onProgress } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0;
    let shown = -1;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((got * 100) / total) : null;
      if (onProgress && pct !== shown) { shown = pct; onProgress({ phase: 'download', percent: pct, bytes: got, total }); }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (sha256 && hash.digest('hex').toLowerCase() !== String(sha256).toLowerCase()) {
      fs.rmSync(file, { force: true });
      return { ok: false, error: 'checksum mismatch' };
    }
    return { ok: true, data: file };
  } catch (e) {
    fs.rmSync(file, { force: true });
    return { ok: false, error: String(e.message || e) };
  }
}

// Graphics drivers: Windows Update lags behind the GPU makers, so check their official sites too.
async function gpuVendorCheck(gpus, amdSoftware) {
  const out = [];
  for (const g of gpus || []) {
    if (/AMD|Radeon/i.test(g.name)) {
      try {
        const html = await (await fetch('https://www.amd.com/en/support/download/drivers.html', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
        const url = (html.match(/https:\/\/drivers\.amd\.com\/drivers\/installer\/[^"'\s]+minimalsetup[^"'\s]+\.exe/) || [])[0];
        const ver = url && (url.match(/adrenalin-edition-([\d.]+)-/) || [])[1];
        out.push({
          gpu: g.name, vendor: 'AMD', installed: g.driverVersion, package: amdSoftware || null, latest: ver || null, url: url || null,
          title: ver ? `AMD Software ${ver}` : null,
          // Unknown package version: offer it rather than hide a possible update.
          newer: !!ver && (!amdSoftware || cmpVer(ver, amdSoftware) > 0),
          page: 'https://www.amd.com/en/support/download/drivers.html',
        });
      } catch (e) {
        out.push({ gpu: g.name, vendor: 'AMD', installed: g.driverVersion, error: String(e.message || e), page: 'https://www.amd.com/en/support/download/drivers.html' });
      }
    } else if (/NVIDIA|GeForce|RTX|GTX|Quadro/i.test(g.name)) {
      out.push(await nvidiaCheck(g));
    } else if (/Intel.*Arc/i.test(g.name)) {
      // intel.com only serves its download pages to browsers; Windows Update carries Intel's
      // releases, and the official page is one click away.
      out.push({ gpu: g.name, vendor: 'Intel', installed: g.driverVersion, latest: null, url: null, newer: false,
        page: 'https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html' });
    }
  }
  return { ok: true, data: out };
}

// NVIDIA's own driver finder: its product list gives the IDs for this card's exact name (listed
// either with or without "NVIDIA"), and the lookup returns the newest Game Ready (WHQL) driver.
let nvidiaProducts = null;
async function nvidiaCheck(g) {
  const base = { gpu: g.name, vendor: 'NVIDIA', installed: g.driverVersion, latest: null, url: null, newer: false, page: 'https://www.nvidia.com/en-us/drivers/' };
  try {
    const norm = (s) => String(s).replace(/^NVIDIA\s+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!nvidiaProducts) {
      const xml = await (await fetch('https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=3', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      nvidiaProducts = [...xml.matchAll(/<LookupValue ParentID="(\d+)">\s*<Name>([^<]+)<\/Name>\s*<Value>(\d+)<\/Value>/g)].map((m) => ({ psid: m[1], name: m[2], pfid: m[3] }));
    }
    const p = nvidiaProducts.find((x) => norm(x.name) === norm(g.name));
    if (!p) return base;
    const osId = Number(os.release().split('.')[2]) >= 22000 ? 135 : 57; // Windows 11 : Windows 10
    const j = await (await fetch(`https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=${p.psid}&pfid=${p.pfid}&osID=${osId}&languageCode=1033&isWHQL=1&dch=1&sort1=0&numberOfResults=1`)).json();
    const d = j?.IDS?.[0]?.downloadInfo;
    if (!d?.Version || !d.DownloadURL) return base;
    // Windows shows NVIDIA drivers as 32.0.15.6636; NVIDIA calls that 566.36 (the last five digits).
    const digits = String(g.driverVersion || '').split('.').slice(-2).join('');
    const installed = digits.length >= 5 ? `${digits.slice(-5, -2)}.${digits.slice(-2)}` : null;
    return {
      ...base, latest: d.Version, url: d.DownloadURL, size: d.DownloadURLFileSize, title: `${decodeURIComponent(d.Name)} ${d.Version}`,
      package: installed, newer: !installed || cmpVer(d.Version, installed) > 0,
    };
  } catch (e) {
    return { ...base, error: String(e.message || e) };
  }
}

// Official installers only, from the GPU maker's own download server, and only if Windows confirms
// the maker's valid signature on the file before it is opened. AMD only lets the file through with
// an amd.com Referer, the same header a browser sends when the link is clicked on their page.
const GPU_SOURCES = [
  { host: /^drivers\.amd\.com$/, signer: /Advanced Micro Devices/i, headers: { Referer: 'https://www.amd.com/' } },
  { host: /^([a-z]+\.)?download\.nvidia\.com$/, signer: /NVIDIA/i, headers: {} },
];
async function downloadGpuInstaller(url, dir, onProgress) {
  const u = new URL(url);
  const src = GPU_SOURCES.find((s) => s.host.test(u.hostname));
  if (u.protocol !== 'https:' || !src) return { ok: false, error: 'not an official GPU download' };
  const r = await downloadFile(url, path.join(dir, path.basename(u.pathname)), { headers: src.headers, onProgress });
  if (!r.ok) return r;
  const sig = await runPS(`$s = Get-AuthenticodeSignature -LiteralPath '${r.data.replace(/'/g, "''")}'; $result = @{ status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject }`);
  if (!sig.ok || sig.data.status !== 'Valid' || !src.signer.test(sig.data.signer)) {
    fs.rmSync(r.data, { force: true });
    return { ok: false, error: 'signature check failed' };
  }
  return r;
}

// ---------------- BIOS ----------------

// ASUS's support site lists every BIOS for a board through the same JSON its own pages load,
// with a SHA-256 for each file. Other makers: a search for their official page.
async function biosCheck(board) {
  const { maker = '', model = '', version = '', date = '' } = board || {};
  const base = { maker, model, installed: version, installedDate: date, supported: false, page: searchPage(maker, model) };
  if (!/ASUS/i.test(maker)) {
    // Brand-name PCs (Lenovo, Dell, HP): the maker's update catalog; others: a search on their site.
    try {
      const oem = await oemBios(board);
      return { ok: true, data: oem ? { ...base, ...oem, installedDate: date, supported: !!oem.latest?.url, flash: 'windows' } : base };
    } catch (e) {
      return { ok: true, data: { ...base, error: String(e.message || e) } };
    }
  }
  if (!model) return { ok: true, data: base };
  try {
    const r = await fetch(`https://www.asus.com/support/api/product.asmx/GetPDBIOS?website=global&model=${encodeURIComponent(model)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    const j = await r.json();
    const files = (j?.Result?.Obj || []).find((o) => o.Name === 'BIOS')?.Files || [];
    if (!files.length) return { ok: true, data: base };
    const f = files.reduce((a, b) => (cmpVer(b.Version, a.Version) > 0 ? b : a));
    const notes = String(f.Description || '').replace(/^"|"$/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    return {
      ok: true,
      data: {
        ...base, supported: true, maker: 'ASUS', site: 'asus.com', flash: 'ezflash', newer: cmpVer(f.Version, version) > 0,
        page: `https://www.asus.com/supportonly/${encodeURIComponent(model)}/helpdesk_bios/`,
        latest: { version: f.Version, date: String(f.ReleaseDate || '').replace(/\//g, '-'), size: f.FileSize, url: f.DownloadUrl?.Global, sha256: f.sha256, notes },
      },
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Only the maker's own download server, only a file whose SHA-256 matches what the maker published,
// and for an .exe also the maker's valid digital signature.
async function downloadBios(latest, dir, onProgress) {
  const u = new URL(latest.url);
  const src = BIOS_SOURCES.find((s) => s.host.test(u.hostname));
  if (u.protocol !== 'https:' || !src || !latest.sha256) return { ok: false, error: 'not an official BIOS download' };
  const r = await downloadFile(u.href, path.join(dir, path.basename(u.pathname)), { sha256: latest.sha256, onProgress });
  if (!r.ok || !src.signer) return r;
  const sig = await runPS(`$s = Get-AuthenticodeSignature -LiteralPath '${r.data.replace(/'/g, "''")}'; $result = @{ status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject }`);
  if (!sig.ok || sig.data.status !== 'Valid' || !src.signer.test(sig.data.signer)) {
    fs.rmSync(r.data, { force: true });
    return { ok: false, error: 'signature check failed' };
  }
  return r;
}

// Only turns back on a device that Device Manager shows as disabled (code 22).
const ENABLE_OP = `
$dev = Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -eq [string]$req.id } | Select-Object -First 1
if (-not $dev -or $dev.ConfigManagerErrorCode -ne 22) { throw 'device is not disabled' }
Enable-PnpDevice -InstanceId $dev.PNPDeviceID -Confirm:$false
$result = 'enabled'`;
const enableDevice = (id) => privileged({ op: 'enable', id: String(id) });

// ---------------- cleanup ----------------

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
function Files($c) {
  # Temp folders: only files untouched for a day, so programs that are open right now keep theirs.
  $cutoff = if ($c.minAgeHours) { (Get-Date).AddHours(-$c.minAgeHours) } else { $null }
  foreach ($p in $c.paths) { if (Test-Path -LiteralPath $p) {
    $f = if ($c.filter) { Get-ChildItem -LiteralPath $p -Filter $c.filter -File -Force -ErrorAction SilentlyContinue } else { Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue }
    if ($cutoff) { $f | Where-Object { $_.LastWriteTime -lt $cutoff } } else { $f } } } }`;

const junkScan = () => runPS(`${JUNK}
$result = @(foreach ($c in $cats) { $f = @(Files $c)
  @{ key = $c.key; admin = $c.admin; bytes = [int64](($f | Measure-Object Length -Sum).Sum); files = $f.Count; minAgeHours = $c.minAgeHours; dirs = @($c.paths | Where-Object { Test-Path -LiteralPath $_ }) } })`);

// Only the fixed categories above can be cleaned, whatever keys arrive.
const CLEAN_OP = `
$want = @($req.keys | ForEach-Object { [string]$_ }); $freed = [int64]0; $skipped = 0
foreach ($c in $cats) { if ($want -notcontains $c.key) { continue }
  foreach ($f in @(Files $c)) { try { $len = $f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $freed += $len } catch { $skipped++ } } }
$result = @{ freed = $freed; skipped = $skipped }`;

// The user's own folders are cleaned as the user; Windows' folders through the service or the
// admin session (which may run as SYSTEM, where "my temp folder" would be the wrong one).
const ADMIN_JUNK = ['winTemp', 'wuCache', 'dumps'];
async function junkClean(keys) {
  const all = keys.map((k) => String(k).replace(/[^a-zA-Z]/g, ''));
  const mine = all.filter((k) => !ADMIN_JUNK.includes(k));
  const sys = all.filter((k) => ADMIN_JUNK.includes(k));
  const total = { freed: 0, skipped: 0 };
  if (mine.length) {
    const r = await runPS(`$req = @{ keys = @(${mine.map((k) => `'${k}'`).join(',')}) }${JUNK}${CLEAN_OP}`);
    if (!r.ok) return r;
    total.freed += r.data.freed; total.skipped += r.data.skipped;
  }
  if (sys.length) {
    const r = await privileged({ op: 'clean', keys: sys }, { timeoutMs: 10 * 60 * 1000 });
    if (!r.ok && !mine.length) return r;
    if (r.ok) { total.freed += r.data.freed; total.skipped += r.data.skipped; } else total.adminError = r.error;
    return { ok: true, data: total, adminUntil: r.adminUntil };
  }
  return { ok: true, data: total };
}

// ---------------- startup apps ----------------

// Same switches Task Manager uses: StartupApproved values starting 02 = on, 03 = off.
const STARTUP = `
$src = @(
  @{ hive = 'HKCU'; run = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; approved = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' }
  @{ hive = 'HKLM'; run = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' }
  @{ hive = 'HKLM32'; run = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32' }
  @{ hive = 'HKCU-F'; folder = [Environment]::GetFolderPath('Startup'); approved = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' }
  @{ hive = 'HKLM-F'; folder = [Environment]::GetFolderPath('CommonStartup'); approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' }
)`;

const startupList = () => runPS(`${STARTUP}
$result = @(foreach ($s in $src) {
  $entries = @()
  if ($s.run -and (Test-Path $s.run)) { $k = Get-Item $s.run; $entries = @($k.GetValueNames() | Where-Object { $_ } | ForEach-Object { @{ name = $_; cmd = [string]$k.GetValue($_) } }) }
  if ($s.folder -and (Test-Path $s.folder)) { $entries = @(Get-ChildItem $s.folder -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object { @{ name = $_.Name; cmd = $_.FullName } }) }
  foreach ($e in $entries) {
    $on = $true
    if (Test-Path $s.approved) { $v = (Get-ItemProperty $s.approved -ErrorAction SilentlyContinue).($e.name); if ($v -is [byte[]] -and $v.Length -gt 0) { $on = ($v[0] % 2 -eq 0) } }
    @{ name = ($e.name -replace '\\.lnk$',''); key = $e.name; cmd = $e.cmd; source = $s.hive; enabled = $on; admin = ($s.hive -like 'HKLM*') }
  } })`);

// Per-user entries change without admin rights; machine-wide ones go through the admin session.
const startupToggle = (source, key, enable) => (/^HKLM/.test(source)
  ? privileged({ op: 'startup', hive: String(source), key: String(key), enable: !!enable })
  : runPS(`${STARTUP}
$s = $src | Where-Object { $_.hive -eq '${String(source).replace(/[^A-Za-z0-9-]/g, '')}' } | Select-Object -First 1
if (-not (Test-Path $s.approved)) { New-Item -Path $s.approved -Force | Out-Null }
$bytes = [byte[]](${enable ? '2' : '3'},0,0,0,0,0,0,0,0,0,0,0)
Set-ItemProperty -Path $s.approved -Name '${String(key).replace(/'/g, "''")}' -Value $bytes -Type Binary
$result = '${enable ? 'enabled' : 'disabled'}'`));

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

// ---------------- admin session ----------------

// One UAC approval starts an elevated helper that serves Tune for the next 10 minutes, so
// installing several drivers or flipping several switches asks once. It runs only the fixed
// operations below, checks every request itself (the folder it reads belongs to the normal
// user), and finishes an operation that is still running when the 10 minutes end.
const ADMIN_WINDOW_S = 10 * 60;
let admin = null; // { dir }

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

const adminHelper = (dir) => `${PRELUDE}$progressFile = $null
function Report-Progress($o) { if ($progressFile) { try { [IO.File]::WriteAllText($progressFile, ($o | ConvertTo-Json -Compress)) } catch {} } }
${STARTUP}${JUNK}${OPS_TABLE()}
$dir = '${dir}'
$deadline = (Get-Date).AddSeconds(${ADMIN_WINDOW_S})
[IO.File]::WriteAllText("$dir\\until", [string]([DateTimeOffset]$deadline).ToUnixTimeMilliseconds())
while ((Get-Date) -lt $deadline) {
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.req' -File)) {
    $id = $f.BaseName -replace '[^a-f0-9]', ''
    $progressFile = "$dir\\$id.progress"
    try {
      $req = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
      Remove-Item -LiteralPath $f.FullName -Force
      $op = $ops[[string]$req.op]
      if (-not $op) { throw 'unknown request' }
      $result = $null
      . $op
      $out = @{ ok = $true; data = $result }
    } catch { $out = @{ ok = $false; error = $_.Exception.Message } }
    $progressFile = $null
    [IO.File]::WriteAllText("$dir\\$id.tmp", ($out | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath "$dir\\$id.tmp" -Destination "$dir\\$id.res" -Force
  }
  Start-Sleep -Milliseconds 150
}
Remove-Item -LiteralPath "$dir\\until" -Force -ErrorAction SilentlyContinue`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adminUntil = () => {
  try { return admin ? Number(fs.readFileSync(path.join(admin.dir, 'until'), 'utf8')) || 0 : 0; } catch { return 0; }
};
// A few seconds of margin so a request never lands just as the helper exits.
const adminAlive = () => adminUntil() - Date.now() > 4000;

function startAdmin() {
  if (admin) fs.rm(admin.dir, { recursive: true, force: true }, () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-admin-'));
  const script = path.join(dir, 'helper.ps1');
  fs.writeFileSync(script, '﻿' + adminHelper(dir), 'utf8');
  admin = { dir };
  return new Promise((resolve) => {
    const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `try { Start-Process -FilePath '${PS}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','"${script}"' -Verb RunAs -WindowStyle Hidden; exit 0 } catch { exit 1223 }`], { windowsHide: true });
    child.on('close', async (code) => {
      if (code !== 0) { admin = null; fs.rm(dir, { recursive: true, force: true }, () => {}); return resolve({ ok: false, error: 'cancelled' }); }
      // Usually under a second; the first run can be slower while antivirus scans the new script.
      for (let i = 0; i < 200 && !adminAlive(); i++) await wait(150);
      resolve(adminAlive() ? { ok: true } : { ok: false, error: 'admin helper did not start' });
    });
  });
}

async function adminCall(req, { timeoutMs = 30000, onProgress } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!adminAlive()) {
      const s = await startAdmin();
      if (!s.ok) return s;
    }
    const { dir } = admin;
    const id = crypto.randomBytes(8).toString('hex');
    const reqFile = path.join(dir, `${id}.req`);
    const resFile = path.join(dir, `${id}.res`);
    const progFile = path.join(dir, `${id}.progress`);
    fs.writeFileSync(reqFile, JSON.stringify(req));
    let picked = false;
    let lastProg = '';
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      if (fs.existsSync(resFile)) {
        const r = JSON.parse(fs.readFileSync(resFile, 'utf8').replace(/^﻿/, ''));
        fs.rm(resFile, { force: true }, () => {});
        fs.rm(progFile, { force: true }, () => {});
        return { ...r, adminUntil: adminStatus() };
      }
      if (!fs.existsSync(dir)) return { ok: false, error: 'admin session ended' };
      if (onProgress) {
        try {
          const s = fs.readFileSync(progFile, 'utf8');
          if (s && s !== lastProg) { lastProg = s; onProgress(JSON.parse(s)); }
        } catch { /* nothing yet */ }
      }
      if (!fs.existsSync(reqFile)) picked = true;
      else if (!adminUntil()) break; // the helper ended without taking it: start a new one and resend
      await wait(150);
    }
    if (picked) return { ok: false, error: 'admin helper did not answer' };
    fs.rmSync(reqFile, { force: true });
  }
  return { ok: false, error: 'admin helper did not answer' };
}

const adminStatus = () => (adminAlive() ? adminUntil() : 0);
// "Approve for 10 minutes" ahead of time, before starting a batch of work.
async function adminStart() {
  if (adminAlive()) return { ok: true, data: adminUntil() };
  const s = await startAdmin();
  return s.ok ? { ok: true, data: adminUntil() } : s;
}
// Removing its folder makes a running helper stop on its next check.
function adminStop() {
  if (admin) fs.rmSync(admin.dir, { recursive: true, force: true });
  admin = null;
}

// ---------------- background service ----------------

// Tune Service (service/TuneService.cs) runs the same operations as LocalSystem, so once it is
// installed nothing asks for approval. Without it, Tune falls back to the 10-minute admin session.
const SERVICE_VERSION = '4';
const PIPE = '\\\\.\\pipe\\TuneService';
// The official, signed PawnIO installer, pinned to the exact file checked when this was written.
const PAWNIO_SETUP = {
  url: 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe',
  sha256: '1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032',
};

// ops.ps1 for the service: the request arrives as base64 JSON; progress and the result go to stdout.
const serviceOpsScript = () => `param([string]$Request)
${PRELUDE}function Report-Progress($o) { [Console]::Out.WriteLine('PROGRESS ' + ($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
${STARTUP}${JUNK}${OPS_TABLE()}
try {
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
  $op = $ops[[string]$req.op]
  if (-not $op) { throw 'unknown request' }
  $result = $null
  . $op
  $out = @{ ok = $true; data = $result }
} catch { $out = @{ ok = $false; error = $_.Exception.Message } }
[Console]::Out.WriteLine('RESULT ' + ($out | ConvertTo-Json -Depth 8 -Compress))
`;

// Resolves to null when the service isn't there (so the caller can fall back), otherwise to its
// answer. A busy or momentarily missing pipe is retried briefly before giving up on it.
async function serviceCall(req, opts = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await serviceOnce(req, opts);
    if (r !== 'retry') return r;
    await wait(120);
  }
  return null;
}

function serviceOnce(req, { timeoutMs = 30000, onProgress } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let connected = false;
    let done = false;
    const sock = net.connect(PIPE);
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const timer = setTimeout(() => finish(connected ? { ok: false, error: 'service did not answer' } : null), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => { connected = true; sock.write(`${JSON.stringify(req)}\n`); });
    sock.on('error', (e) => finish(connected ? { ok: false, error: String(e.message || e) } : ['ENOENT', 'EBUSY'].includes(e.code) ? 'retry' : null));
    sock.on('close', () => finish(connected ? { ok: false, error: 'service closed the connection' } : null));
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.progress) { if (onProgress) onProgress(m.progress); continue; }
        finish({ ...m, via: 'service' });
      }
    });
  });
}

// Every privileged operation: the service if it's running, otherwise the admin session.
async function privileged(req, opts) {
  const r = await serviceCall(req, opts);
  return r || adminCall(req, opts);
}

async function serviceStatus() {
  const v = await serviceCall({ op: 'version' }, { timeoutMs: 3000 });
  if (v && v.ok) return { ok: true, data: { installed: true, running: true, ...v.data, current: v.data.version === SERVICE_VERSION } };
  const q = await runPS("$s = Get-Service TuneService -ErrorAction SilentlyContinue; $result = if ($s) { [string]$s.Status } else { '' }");
  return { ok: true, data: { installed: !!(q.ok && q.data), running: false, state: q.ok ? q.data : null } };
}

// One-off elevated script (one UAC prompt, then it exits), for installing or removing the service.
function runElevated(body, { timeoutMs = 10 * 60 * 1000, onProgress } = {}) {
  const out = tempFile('json');
  const prog = tempFile('progress');
  const script = tempFile('ps1');
  fs.writeFileSync(script, '﻿' + `${PRELUDE}$progressFile = '${prog}'
function Report-Progress($o) { try { [IO.File]::WriteAllText($progressFile, ($o | ConvertTo-Json -Compress)) } catch {} }
try {
${body}
$payload = @{ ok = $true; data = $result } } catch { $payload = @{ ok = $false; error = $_.Exception.Message } }
[IO.File]::WriteAllText('${out}', ($payload | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding $false))`, 'utf8');
  return new Promise((resolve) => {
    const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `try { $p = Start-Process -FilePath '${PS}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','"${script}"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`], { windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let last = '';
    const poll = setInterval(() => {
      try { const s = fs.readFileSync(prog, 'utf8'); if (s && s !== last) { last = s; if (onProgress) onProgress(JSON.parse(s)); } } catch { /* not yet */ }
    }, 400);
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      let res;
      try { res = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, '')); } catch { res = code === 1223 ? { ok: false, error: 'cancelled' } : { ok: false, error: `no result (exit ${code})` }; }
      for (const f of [out, prog, script]) fs.rm(f, { force: true }, () => {});
      resolve(res);
    });
  });
}

// Copies the service into Program Files (only administrators can change it there), registers it to
// start with Windows and restart if it stops, and installs the official PawnIO driver (CPU and
// motherboard sensors) if it isn't there yet (downloaded into the protected folder and checked first).
function installService(srcDir, onProgress) {
  return runElevated(`
$src = '${String(srcDir).replace(/'/g, "''")}'
$dst = Join-Path $env:ProgramFiles 'Tune Service'
foreach ($f in @('TuneService.exe', 'ops.ps1', 'LibreHardwareMonitorLib.dll')) { if (-not (Test-Path -LiteralPath (Join-Path $src $f))) { throw "missing $f" } }
$files = @(Get-ChildItem -LiteralPath $src -File | Where-Object { $_.Extension -in '.exe', '.dll', '.ps1', '.txt' } | ForEach-Object { $_.Name })
Report-Progress @{ phase = 'service' }
$svc = Get-Service TuneService -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service TuneService -Force; $svc.WaitForStatus('Stopped', '00:00:20') }
New-Item -ItemType Directory -Path $dst -Force | Out-Null
# A fresh folder each time, so files from an older version don't linger.
Get-ChildItem -LiteralPath $dst -File -ErrorAction SilentlyContinue | Remove-Item -Force
foreach ($f in $files) { Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force }
$bin = '"' + (Join-Path $dst 'TuneService.exe') + '"'
if (-not $svc) {
  New-Service -Name TuneService -BinaryPathName $bin -DisplayName 'Tune Service' -StartupType Automatic -Description 'Lets Tune install drivers and apply settings without a prompt each time, and reads hardware temperatures.' | Out-Null
} else { Set-Service -Name TuneService -StartupType Automatic }
sc.exe failure TuneService reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
$pawn = 'present'
if (-not (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PawnIO' -ErrorAction SilentlyContinue)) {
  Report-Progress @{ phase = 'pawnio' }
  $setup = Join-Path $dst 'PawnIO_setup.exe'
  Invoke-WebRequest -UseBasicParsing '${PAWNIO_SETUP.url}' -OutFile $setup
  if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ne '${PAWNIO_SETUP.sha256}') { Remove-Item -LiteralPath $setup -Force; throw 'the PawnIO download does not match the official file' }
  if ((Get-AuthenticodeSignature -LiteralPath $setup).Status -ne 'Valid') { Remove-Item -LiteralPath $setup -Force; throw 'the PawnIO signature is not valid' }
  $p = Start-Process -FilePath $setup -ArgumentList '-install', '-silent' -Wait -PassThru
  Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
  $pawn = switch ($p.ExitCode) { 0 { 'installed' } 3010 { 'reboot' } default { "failed ($($p.ExitCode))" } }
}
Report-Progress @{ phase = 'start' }
Start-Service TuneService
$result = @{ service = 'running'; pawnio = $pawn }`, { onProgress });
}

// Removes the service and its folder. PawnIO stays (it has its own entry in Windows' app list).
const uninstallService = () => runElevated(`
$svc = Get-Service TuneService -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service TuneService -Force; $svc.WaitForStatus('Stopped', '00:00:20') }
  sc.exe delete TuneService | Out-Null
}
Start-Sleep -Milliseconds 500
Remove-Item -LiteralPath (Join-Path $env:ProgramFiles 'Tune Service') -Recurse -Force -ErrorAction SilentlyContinue
$result = 'removed'`);

// ---------------- performance ----------------

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

// Only the service's sensors (and the load): quick enough to refresh every couple of seconds while
// a page shows them.
async function sensors() {
  const load = cpuLoadNow();
  return { ok: true, data: { ...liveCpu(await serviceCall({ op: 'sensors' }, { timeoutMs: 5000 })), cpuLoad: load } };
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

// ---------------- recommendations ----------------

// The power plan each kind of processor's maker recommends. Intel (12th gen and later, with
// performance + efficient cores) and AMD (Ryzen; X3D chips depend on it) both recommend Windows'
// Balanced plan: full speed under load, rest in between. Older Intel desktops do fine with High
// performance too. Laptops: Balanced.
const PLAN_GUIDS = {
  '381b4222-f694-41f0-9685-ff5bb260df2e': 'balanced',
  '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'high',
  'e9a42b02-d5df-448d-aa00-03f14749eb61': 'ultimate',
  'a1841308-3541-4fab-bc81-f71556f20b4a': 'saver',
};
// Built-in plans by their fixed ID; copies (Ultimate Performance is usually one) by name, which
// Windows gives in its own language.
const planKind = (guid, name) => PLAN_GUIDS[String(guid).toLowerCase()]
  || (/ultimate|אולטימטיב|מרבי|מקסימלי/i.test(name) ? 'ultimate'
    : /high perf|ביצועים גבוהים/i.test(name) ? 'high'
      : /saver|חיסכון/i.test(name) ? 'saver'
        : /balanced|מאוזן/i.test(name) ? 'balanced' : 'custom');
function cpuKind(cpu) {
  if (/Ryzen\s+9\s+(7900|7950|9900|9950)X3D/i.test(cpu)) return 'amdX3D';
  if (/Ryzen|AMD/i.test(cpu)) return 'amd';
  if (/Core\s*(\(TM\))?\s*Ultra|i[3579]-1[2-4]\d{3}|Core\s*(\(TM\))?\s*[3579]\s+\d{3}/i.test(cpu)) return 'intelHybrid';
  if (/Intel/i.test(cpu)) return 'intel';
  return 'other';
}
function powerAdvice(x) {
  const plan = planKind(x.guid, x.value);
  const kind = x.laptop ? 'laptop' : cpuKind(x.cpu);
  const ok = plan === 'balanced' || (kind === 'intel' && plan === 'high');
  return { ...x, plan, cpuKind: kind, recommended: 'balanced', ok, action: ok ? null : 'power' };
}

const recommendations = async () => {
  const r = await runPS(`
$scheme = [string](powercfg /getactivescheme)
$planGuid = ([regex]::Match($scheme, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')).Value
$plan = ([regex]::Match($scheme, '\\(([^)]*)\\)\\s*$')).Groups[1].Value
$laptop = [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
$gm = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\GameBar' -ErrorAction SilentlyContinue).AutoGameModeEnabled
$hags = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -ErrorAction SilentlyContinue).HwSchMode
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$bios = Get-CimInstance Win32_BIOS; $bb = Get-CimInstance Win32_BaseBoard
$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB); $sizeGB = [math]::Round(((Get-PSDrive C).Used + (Get-PSDrive C).Free) / 1GB)
# Memory sticks as the board describes them (slot names, rated and current speed, part number).
$mods = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ locator = [string]$_.DeviceLocator; bank = [string]$_.BankLabel; speed = [int]$_.Speed; configured = [int]$_.ConfiguredClockSpeed; part = ([string]$_.PartNumber).Trim(); type = [int]$_.SMBIOSMemoryType; gb = [math]::Round($_.Capacity / 1GB) } })
$slots = [int](Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum
# The microcode Windows loaded (Intel's fixes arrive in it); 4 or 8 bytes depending on the system.
$ucode = $null
try { $u = (Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0').'Update Revision'; if ($u) { $ucode = if ($u.Length -ge 8) { [BitConverter]::ToUInt32($u, 4) } else { [BitConverter]::ToUInt32($u, 0) } } } catch {}
$ssd = [bool](Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.MediaType -eq 'SSD' })
$trim = $null
$tq = (fsutil behavior query DisableDeleteNotify 2>$null) | Out-String
$tm = [regex]::Match($tq, 'NTFS DisableDeleteNotify\\s*=\\s*(\\d)'); if ($tm.Success) { $trim = ($tm.Groups[1].Value -eq '0') }
# Plain data only; the app words it in the user's language and judges it (advise).
$result = @(
  @{ key = 'power'; value = $plan; guid = $planGuid; cpu = $cpu; laptop = $laptop }
  @{ key = 'microcode'; cpu = $cpu; rev = $ucode; laptop = $laptop }
  @{ key = 'gamemode'; on = ($gm -ne 0); ok = ($gm -ne 0); action = $(if ($gm -eq 0) { 'gamemode' } else { $null }) }
  @{ key = 'hags'; on = ($hags -eq 2); ok = ($hags -eq 2); action = $(if ($hags -eq 2) { $null } else { 'hags' }) }
  @{ key = 'disk'; freeGB = $freeGB; sizeGB = $sizeGB; ok = ($freeGB -gt 0.1 * $sizeGB); action = $null }
  @{ key = 'trim'; ssd = $ssd; on = $trim }
  @{ key = 'memory'; modules = $mods; slots = $slots; cpu = $cpu; laptop = $laptop; boardMaker = [string]$bb.Manufacturer; boardModel = [string]$bb.Product }
  @{ key = 'bios'; version = $bios.SMBIOSBIOSVersion; date = $bios.ReleaseDate.ToString('yyyy-MM-dd'); ok = $null
     intel1314 = ($cpu -match 'i[579]-1[34]\\d{3}')
     action = 'biosPage'; link = "https://www.google.com/search?q=$([uri]::EscapeDataString("$($bb.Manufacturer) $($bb.Product) BIOS"))" }
)`);
  if (r.ok) r.data = advise([].concat(r.data || []));
  return r;
};

// ---- judging the raw data ----

// 13th–14th gen Intel desktop chips (65 W and up) and the voltage fix Intel ships in microcode:
// 0x12B is the fix itself, later revisions refine it. Laptop chips (H/HX/U/P) are not affected.
const INTEL_1314_DESKTOP = /i[579]-1[34]\d{3}(KS|KF|K|F|T)?(?![A-Z0-9])/i;
const MICROCODE_FIX = 0x12B;

// Which memory channel a stick sits in, from the slot names the board reports: "Controller0-DIMM1"
// (Intel: one controller per channel), "ChannelA-DIMM0", "P0 CHANNEL A" (AMD), "DIMM_B2", "A1".
function memChannel(m) {
  const s = `${m.locator} ${m.bank}`;
  const ctrl = (s.match(/controller\s*(\d+)/i) || [])[1];
  const ch = (s.match(/channel\s*([a-h])\b/i) || m.locator.match(/DIMM[\s_-]*([a-h])\d/i) || m.locator.match(/^([a-h])\d\b/i) || [])[1];
  if (ctrl == null && ch == null) return null;
  return `${ctrl ?? ''}${(ch || '').toUpperCase()}`;
}

// The speed a kit is sold at, from its part number (G.Skill F5-6000…, Corsair …M2B6000C36,
// Kingston KF560C36…, Crucial …16G60C38…, TeamGroup …16G6000HC38…), when it can be read.
const MEM_SPEEDS = [2133, 2400, 2666, 2933, 3000, 3200, 3466, 3600, 3733, 3866, 4000, 4133, 4266, 4400, 4800, 5200, 5600, 6000, 6200, 6400, 6600, 6800, 7000, 7200, 7600, 8000, 8200, 8400];
function ratedFromPart(part = '') {
  const p = part.toUpperCase();
  const tries = [
    p.match(/^F[345]-(\d{4})/), p.match(/M\dB(\d{4})C/), p.match(/G(\d{4})HC/),
  ].filter(Boolean).map((m) => +m[1]);
  const kf = p.match(/^KF([345])(\d{2})C/); if (kf) tries.push(+kf[2] * 100);
  const cr = p.match(/\d+G(\d{2})C\d{2}/); if (cr) tries.push(+cr[1] * 100);
  return tries.map((v) => (v === 2660 ? 2666 : v === 2930 ? 2933 : v)).find((v) => MEM_SPEEDS.includes(v)) || null;
}

function memoryAdvice(x) {
  const mods = [].concat(x.modules || []).filter((m) => m && m.gb > 0);
  if (!mods.length) return [];
  const amd = /AMD|Ryzen/i.test(x.cpu || '');
  const base = { group: 'memory', boardMaker: x.boardMaker, boardModel: x.boardModel, profile: amd ? 'EXPO' : 'XMP' };
  // Channels: two sticks in the same channel run at half the memory speed of two channels.
  const keys = mods.map(memChannel);
  const channels = keys.every((k) => k != null) ? new Set(keys).size : null;
  const chan = {
    ...base, key: 'memChannels', sticks: mods.length, channels, slots: x.slots, laptop: x.laptop,
    ok: channels == null ? null : channels >= 2 ? true : x.laptop && mods.length === 1 ? null : false,
    guide: channels === 1 && mods.length > 1 ? 'channels' : null,
  };
  // Speed: running below what the kit is sold at means its XMP/EXPO profile is off.
  const configured = Math.min(...mods.map((m) => m.configured || m.speed || 0));
  const rated = Math.max(...mods.map((m) => Math.max(ratedFromPart(m.part) || 0, m.speed || 0)));
  const ddr = mods[0].type === 34 ? 5 : mods[0].type === 26 ? 4 : null;
  const speed = {
    ...base, key: 'memSpeed', configured, rated, ddr,
    ok: !configured || !rated ? null : configured >= rated * 0.97,
    guide: rated && configured && configured < rated * 0.97 ? 'xmp' : null,
  };
  return x.laptop ? [chan] : [chan, speed];
}

function advise(list) {
  const out = [];
  for (const x of list) {
    if (x.key === 'power') {
      const p = powerAdvice(x);
      out.push({ ...p, group: 'cpu' });
      // Desktop CPUs that boost to 150 W and more: lowering the power limit in the BIOS is the
      // most effective way to run cooler. A tip, judged on the page from the live readings.
      if (!x.laptop && ['intelHybrid', 'amd', 'amdX3D'].includes(p.cpuKind)) out.push({ key: 'powerLimit', group: 'cpu', cpuKind: p.cpuKind, intel1314: INTEL_1314_DESKTOP.test(x.cpu || ''), ok: null, guide: 'powerLimit' });
    } else if (x.key === 'microcode') {
      if (x.laptop || !INTEL_1314_DESKTOP.test(x.cpu || '') || x.rev == null) continue;
      out.push({ key: 'microcode', group: 'cpu', rev: x.rev, hex: `0x${Number(x.rev).toString(16).toUpperCase()}`, ok: x.rev >= MICROCODE_FIX, action: null });
    } else if (x.key === 'memory') {
      out.push(...memoryAdvice(x));
    } else if (x.key === 'trim') {
      if (!x.ssd || x.on == null) continue;
      out.push({ ...x, group: 'storage', ok: !!x.on, action: null });
    } else {
      const group = { gamemode: 'windows', hags: 'gpu', disk: 'storage', bios: 'board' }[x.key] || 'windows';
      out.push({ ...x, group });
    }
  }
  return out;
}

const applyRecommendation = (key) => {
  const scripts = {
    // Windows' built-in Balanced plan, by its fixed ID (exists on every Windows).
    power: { body: "powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e; $result = 'ok'" },
    gamemode: { body: "New-Item 'HKCU:\\Software\\Microsoft\\GameBar' -Force | Out-Null; Set-ItemProperty 'HKCU:\\Software\\Microsoft\\GameBar' -Name AutoGameModeEnabled -Value 1 -Type DWord; $result = 'ok'" },
  };
  if (key === 'hags') return privileged({ op: 'hags' });
  const s = scripts[key];
  return s ? runPS(s.body) : Promise.resolve({ ok: false, error: 'unknown' });
};

// Restore points are system-wide, so Windows only lets an administrator make one. Inside an open
// admin session (for example right after startup switches) it doesn't ask again.
const createRestorePoint = () => privileged({ op: 'restore' }, { timeoutMs: 5 * 60 * 1000 });

function openSystemRestore() {
  spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rstrui.exe'), [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  scanHardware, driverUpdates, gpuVendorCheck, downloadGpuInstaller, installDrivers, enableDevice,
  biosCheck, downloadBios,
  junkScan, junkClean, startupList, startupToggle, performance, sensors, recommendations, applyRecommendation,
  memChannel, ratedFromPart, advise,
  createRestorePoint, openSystemRestore, adminStatus, adminStart, adminStop,
  serviceStatus, installService, uninstallService, serviceOpsScript, SERVICE_VERSION,
};
