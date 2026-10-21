// The background service (LocalSystem): calling it, its status, installing, updating and removing it.
const fs = require('fs');
const path = require('path');
const { PRELUDE, runPS } = require('../infra/powershell.cjs');
const { adminCall } = require('./admin-session.cjs');
const { JUNK, OPS_TABLE, STARTUP } = require('./operations.cjs');
const { pipeCall } = require('./pipe.cjs');
const { runElevated } = require('./elevated.cjs');

// Tune Service (service/TuneService.cs) runs the same operations as LocalSystem, so once it is
// installed nothing asks for approval. Without it, Tune falls back to the 10-minute admin session.
// Its version comes from one place (service-version.cjs), compiled into the service too.
const SERVICE_VERSION = require('./service-version.cjs');

const PIPE = 'TuneService';
let operationStore = null;
let recovering = null;
const setOperationStore = store => { operationStore = store; };

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
  const r = await pipeCall(PIPE, req, opts);
  return r ? { ...r, via: 'service' } : null;
}

// Whether the service that answers on the pipe may run this app's changes (WIN-R03): only the version
// this app was built with (service-version.cjs). An older one lacks fixes the app relies on (who may
// ask, TUN-01; deadlines and containment, TUN-06 and WIN-R02), and one that doesn't answer a
// well-formed version can't be trusted with a change. -> { state, version }:
//   'current'       this version
//   'outdated'      another, well-formed version (e.g. 6 or 7 from an earlier Tune)
//   'unverifiable'  something answers on the pipe, but not with a well-formed version
//   'missing'       nothing answers on the pipe
const WELL_FORMED = /^\d{1,6}$/;
async function serviceCompat() {
  const v = await serviceCall({ op: 'version' }, { timeoutMs: 3000 });
  if (!v) return { state: 'missing', version: null };
  const raw = v.ok && v.data ? v.data.version : undefined;
  const version = (typeof raw === 'string' || Number.isSafeInteger(raw)) && WELL_FORMED.test(String(raw)) ? String(raw) : null;
  if (!version) return { state: 'unverifiable', version: null };
  return { state: version === SERVICE_VERSION ? 'current' : 'outdated', version, info: v.data };
}

// Every privileged operation. The service runs it only when it is this app's version (above);
// otherwise, old, unverifiable or missing, it goes through the admin session (Windows' own approval
// prompt), never to that service. Safe routing here doesn't fix an old service itself: it still runs
// and other programs on this PC can still ask it; only updating it (Settings) does.
// After the service is asked, the admin session is used only when the request certainly didn't run:
// the service refused this user before running anything ('notAllowed', audit TUN-01), or nothing was
// there to receive it (null: never connected). An answer that never came after the request was sent
// ('noAnswer') may mean it ran, so it is not tried a second time; 'busy' and 'timedOut' are answers.
async function privileged(req, opts) {
  const compat = await serviceCompat();
  if (compat.state !== 'current') return adminCall(req, opts);
  let operationId = null;
  if (operationStore) {
    try { operationId = operationStore.begin(req); }
    catch { return { ok: false, error: 'the operation could not be recorded; nothing was started', code: 'journalUnavailable' }; }
  }
  let r;
  try { r = await serviceCall(operationId ? { ...req, operationId } : req, opts); }
  catch { r = { ok: false, error: 'the action has no confirmed result; check History before trying again', code: 'noAnswer' }; }
  if (!r || (r.ok === false && r.code === 'notAllowed')) {
    if (operationId) try { operationStore.settle(operationId, { ok: false, error: 'not run by the service', code: 'notStarted' }); } catch {}
    return adminCall(req, opts);
  }
  if (operationId) {
    r = { ...r, operationId };
    try { operationStore.settle(operationId, r); } catch { /* the durable pending ID still permits recovery */ }
  }
  return r;
}

// The local view also supplies conservative comparison boundaries for unconfirmed changes.
function operationHistoryView(history = []) {
  if (!operationStore) return [];
  const recorded = new Set(history.filter(h => h.action !== 'serviceOperation').map(h => h.detail?.operationId).filter(Boolean));
  return operationStore.read().filter(r => !recorded.has(r.id) && r.result?.code !== 'notStarted').map(r => ({
    id: r.id, action: 'serviceOperation', at: r.startedAt,
    detail: { operationId: r.id, op: r.op, operationState: r.state, result: r.result || null },
  }));
}
async function operationHistory(history = []) {
  if (!operationStore) return [];
  if (operationStore.read().some(r => ['running', 'unknown'].includes(r.state))) {
    if (!recovering) recovering = (async () => {
      if ((await serviceCompat()).state === 'current')
        await operationStore.recover(id => serviceCall({ op: 'operationStatus', operationId: id }, { timeoutMs: 2000 }));
    })().finally(() => { recovering = null; });
    await recovering;
  }
  return operationHistoryView(history);
}

// For Settings: whether the service is installed and running, its version, and whether it is this
// app's (only then does it run changes; anything else is offered as an update).
async function serviceStatus() {
  const c = await serviceCompat();
  if (c.state === 'current' || c.state === 'outdated') {
    return { ok: true, data: { ...(c.info || {}), installed: true, running: true, version: c.version, current: c.state === 'current', compat: c.state } };
  }
  if (c.state === 'unverifiable') return { ok: true, data: { installed: true, running: true, version: null, current: false, compat: 'unverifiable' } };
  const q = await runPS("$s = Get-Service TuneService -ErrorAction SilentlyContinue; $result = if ($s) { [string]$s.Status } else { '' }");
  const installed = !!(q.ok && q.data);
  return { ok: true, data: { installed, running: false, version: null, current: false, compat: installed ? 'stopped' : 'missing', state: q.ok ? q.data : null } };
}

// What this version of Tune expects the service files to be: written by scripts/build-service.cjs
// into the app itself (service-manifest.json), next to this file.
function bundledManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-manifest.json'), 'utf8'));
    return m && typeof m.version === 'string' && m.files && typeof m.files === 'object' ? m : null;
  } catch { return null; }
}

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The folder the service lives in: only administrators and SYSTEM can change it, users can read and
// run it. Set explicitly (no inherited entries) and checked afterwards.
const PROTECT_PS = `
$adminsSid = 'S-1-5-32-544'; $systemSid = 'S-1-5-18'; $trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
function Protect-Folder([string]$path) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($adminsSid)))
  $flags = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($e in @(@($adminsSid, 'FullControl'), @($systemSid, 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($e[0])), [Security.AccessControl.FileSystemRights]$e[1], $flags, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
function Assert-Protected([string]$path) {
  $write = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
  foreach ($r in (Get-Acl -LiteralPath $path).Access) {
    if ($r.AccessControlType -ne 'Allow' -or -not ($r.FileSystemRights -band $write)) { continue }
    $sid = try { $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$r.IdentityReference }
    if ($sid -notin @($adminsSid, $systemSid, $trustedInstaller)) { throw "the service folder can be changed by $sid" }
  }
}`;

// Asks the service for its version over its pipe (as the elevated installer): true when the expected
// version answers within $seconds.
const HEALTH_PS = `
function Test-ServiceAnswers([string]$version, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $c = $null
    try {
      $c = New-Object IO.Pipes.NamedPipeClientStream('.', '${PIPE}', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous, [Security.Principal.TokenImpersonationLevel]::Identification)
      $c.Connect(2000)
      $bytes = [Text.Encoding]::UTF8.GetBytes("{""op"":""version""}\`n"); $c.Write($bytes, 0, $bytes.Length); $c.Flush()
      $v = (Read-TuneLine $c 5000) | ConvertFrom-Json
      if ($v.ok -and [string]$v.data.version -eq $version) { return $true }
    } catch {} finally { if ($c) { $c.Dispose() } }
    Start-Sleep -Milliseconds 500
  }
  return $false
}`;

// Installs or updates the service (audit TUN-02 and TUN-12):
// 1. the files go into a new folder for this version inside Program Files\Tune Service (only
//    administrators can change it), and each copy is checked there against the manifest built with
//    this version of Tune before anything uses it: a file changed in the per-user install folder is
//    refused, and the running service is left as it was;
// 2. the service is switched to the new folder and must answer with the new version within 30 s;
//    otherwise it is switched back to the previous version (or removed if there was none) and the
//    new folder is deleted, so a failed update never leaves Tune without a working service;
// 3. only then are older folders removed (the previous one is kept for one more update).
// It also installs the official PawnIO driver (CPU sensors) if it isn't there yet (downloaded into
// the protected folder and checked first).
// A manifest names only plain file names, each with a SHA-256, and a whole-number version; a signed
// build also names its signer's certificate thumbprint.
const validManifest = (m) => !!m && /^\d+$/.test(String(m.version)) && !!m.files && typeof m.files === 'object'
  && Object.keys(m.files).length > 0
  && Object.entries(m.files).every(([n, h]) => /^[A-Za-z0-9._-]+$/.test(n) && !/^\.+$/.test(n) && /^[0-9A-F]{64}$/.test(h))
  && (m.signer === undefined || /^[0-9A-F]{40}$/.test(m.signer));

function installService(srcDir, onProgress, { manifest = bundledManifest() } = {}) {
  if (!manifest) return Promise.resolve({ ok: false, error: 'this build of Tune has no service manifest (npm run build:service)' });
  if (!validManifest(manifest)) return Promise.resolve({ ok: false, error: 'the service manifest is not valid' });
  return runElevated(installScript(srcDir, manifest), { onProgress });
}

// The elevated body of installService (the pipe helpers it uses, such as Read-TuneLine, come with
// runElevated's script).
function installScript(srcDir, manifest) {
  const tag = `v${manifest.version}-${String(manifest.id || '').slice(0, 12)}`.replace(/[^A-Za-z0-9.-]/g, '');
  const expected = Object.keys(manifest.files).map((n) => `@(${psString(n)}, ${psString(manifest.files[n])})`).join(', ');
  return `${PROTECT_PS}${HEALTH_PS}
$src = ${psString(srcDir)}
$root = Join-Path $env:ProgramFiles 'Tune Service'
# a new folder for every install, so the running version's folder is never touched (rollback target)
$dst = Join-Path $root (${psString(tag)} + '-' + (Get-Date -Format 'yyyyMMddHHmmss'))
$expected = @(${expected})
Report-Progress @{ phase = 'service' }
New-Item -ItemType Directory -Path $root -Force | Out-Null
Protect-Folder $root
Assert-Protected $root
$journal = Join-Path $root 'journal'
if ((Test-Path -LiteralPath $journal) -and ((Get-Item -LiteralPath $journal -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'operation journal must not be a reparse point' }
New-Item -ItemType Directory -Path $journal -Force | Out-Null
Protect-Folder $journal
Assert-Protected $journal
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
New-Item -ItemType Directory -Path $dst | Out-Null
foreach ($e in $expected) {
  $to = Join-Path $dst $e[0]
  Copy-Item -LiteralPath (Join-Path $src $e[0]) -Destination $to
  if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $e[1]) {
    Remove-Item -LiteralPath $dst -Recurse -Force
    throw "the service file $($e[0]) does not match this version of Tune; nothing was changed"
  }
}
Assert-Protected $dst
${manifest.signer ? `# a signed build: the service must carry a valid signature from the same certificate (audit TUN-09)
$sig = Get-AuthenticodeSignature -LiteralPath (Join-Path $dst 'TuneService.exe')
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Thumbprint -ne ${psString(manifest.signer)}) {
  Remove-Item -LiteralPath $dst -Recurse -Force
  throw "the service is not validly signed by Tune's publisher ($($sig.Status)); nothing was changed"
}
` : ''}$svc = Get-Service TuneService -ErrorAction SilentlyContinue
$previous = if ($svc) { [string](Get-CimInstance Win32_Service -Filter "Name='TuneService'").PathName } else { $null }
$bin = '"' + (Join-Path $dst 'TuneService.exe') + '"'
if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service TuneService -Force; $svc.WaitForStatus('Stopped', '00:00:20') }
if (-not $svc) {
  New-Service -Name TuneService -BinaryPathName $bin -DisplayName 'Tune Service' -StartupType Automatic -Description 'Lets Tune install drivers and apply settings without a prompt each time, and reads hardware temperatures.' | Out-Null
} else {
  & sc.exe config TuneService binPath= $bin start= auto | Out-Null
  if ($LASTEXITCODE) { throw "could not point the service at the new version (sc $LASTEXITCODE)" }
}
& sc.exe failure TuneService reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
Report-Progress @{ phase = 'start' }
try { Start-Service TuneService } catch {}
if (-not (Test-ServiceAnswers ${psString(manifest.version)} 30)) {
  try { Stop-Service TuneService -Force -ErrorAction SilentlyContinue } catch {}
  if ($previous) {
    & sc.exe config TuneService binPath= $previous | Out-Null
    try { Start-Service TuneService } catch {}
    $kept = 'the previous version was restored'
  } else {
    & sc.exe delete TuneService | Out-Null
    $kept = 'it was not installed'
  }
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $dst -Recurse -Force -ErrorAction SilentlyContinue
  throw "the new background service did not start; $kept"
}
# Older versions go; the previous one stays for one more update. Files of the first layout (directly
# in the folder, service version 6 and before) go once the new version answers.
foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory)) {
  if ($d.Name -eq 'journal' -or $d.FullName -eq $dst -or ($previous -and $previous.Contains($d.FullName + '\\'))) { continue }
  Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -ne 'PawnIO_setup.exe' } | Remove-Item -Force -ErrorAction SilentlyContinue
# PawnIO (CPU sensors) comes after the service answers: a download or driver problem is reported in
# the result, and never leaves the service itself stopped.
$pawn = 'present'
if (-not (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PawnIO' -ErrorAction SilentlyContinue)) {
  Report-Progress @{ phase = 'pawnio' }
  $setup = Join-Path $root 'PawnIO_setup.exe'
  try {
    Invoke-WebRequest -UseBasicParsing '${PAWNIO_SETUP.url}' -OutFile $setup
    if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ne '${PAWNIO_SETUP.sha256}') { throw 'the PawnIO download does not match the official file' }
    if ((Get-AuthenticodeSignature -LiteralPath $setup).Status -ne 'Valid') { throw 'the PawnIO signature is not valid' }
    $p = Start-Process -FilePath $setup -ArgumentList '-install', '-silent' -Wait -PassThru
    $pawn = switch ($p.ExitCode) { 0 { 'installed' } 3010 { 'reboot' } default { "failed ($($p.ExitCode))" } }
  } catch { $pawn = "failed: $($_.Exception.Message)" }
  Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
}
$result = @{ service = 'running'; version = ${psString(manifest.version)}; pawnio = $pawn }`;
}

// Removes the service and its folder, and says so when it couldn't (the uninstaller reports that).
// PawnIO stays (it has its own entry in Windows' app list).
const uninstallScript = () => `
$svc = Get-Service TuneService -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service TuneService -Force; $svc.WaitForStatus('Stopped', '00:00:20') }
  & sc.exe delete TuneService | Out-Null
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 1060) { throw "the service could not be removed (sc $LASTEXITCODE)" }
}
for ($i = 0; $i -lt 40 -and (Get-Service TuneService -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
if (Get-Service TuneService -ErrorAction SilentlyContinue) { throw 'the service is still registered' }
$root = Join-Path $env:ProgramFiles 'Tune Service'
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
$result = 'removed'`;
const uninstallService = () => runElevated(uninstallScript());

module.exports = {
  SERVICE_VERSION, serviceOpsScript, serviceCall, serviceCompat, privileged, serviceStatus, setOperationStore, operationHistory, operationHistoryView, installService, uninstallService,
  bundledManifest, validManifest, installScript, uninstallScript,
};
