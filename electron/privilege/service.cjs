// The background service (LocalSystem): calling it, its status, installing and removing it.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const { PRELUDE, PS, runPS, tempFile } = require('../infra/powershell.cjs');
const { adminCall, wait } = require('./admin-session.cjs');
const { JUNK, OPS_TABLE, STARTUP } = require('./operations.cjs');

// Tune Service (service/TuneService.cs) runs the same operations as LocalSystem, so once it is
// installed nothing asks for approval. Without it, Tune falls back to the 10-minute admin session.
const SERVICE_VERSION = '5';

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
    child.on('error', (e) => {
      clearTimeout(timer);
      clearInterval(poll);
      for (const f of [out, prog, script]) fs.rm(f, { force: true }, () => {});
      resolve({ ok: false, error: `could not start PowerShell: ${e.message}` });
    });
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

module.exports = { SERVICE_VERSION, serviceOpsScript, serviceCall, privileged, serviceStatus, installService, uninstallService };
