// The admin session: one UAC prompt covers the next 10 minutes of admin operations (used when the
// background service is not installed).
const { PRELUDE } = require('../infra/powershell.cjs');
const { JUNK, OPS_TABLE, STARTUP } = require('./operations.cjs');
const { pipeCall, wait, PIPE_SERVER_PS } = require('./pipe.cjs');
const { newPipeName, startElevated } = require('./elevated.cjs');

// One UAC approval starts an elevated helper that serves Tune for the next 10 minutes, so
// installing several drivers or flipping several switches asks once. It runs only the fixed
// operations below and checks every request itself. It is started from the command line alone (no
// script file) and answers on its own pipe, open to this Windows user only (privilege/elevated.cjs,
// audit TUN-02). It finishes an operation that is still running when the 10 minutes end, and stops
// early when Tune closes or asks it to.
const ADMIN_WINDOW_S = 10 * 60;

let admin = null; // { pipe, until }

const adminHelper = (pipeName, tunePid) => `${PRELUDE}${PIPE_SERVER_PS}${STARTUP}${JUNK}${OPS_TABLE()}
$tunePid = ${Number(tunePid) || 0}
$deadline = (Get-Date).AddSeconds(${ADMIN_WINDOW_S})
$until = ([DateTimeOffset]$deadline).ToUnixTimeMilliseconds()
function Tune-Open { if (-not $tunePid) { return $true }; return [bool](Get-Process -Id $tunePid -ErrorAction SilentlyContinue) }
while ((Get-Date) -lt $deadline -and (Tune-Open)) {
  $pipe = New-TunePipe '${pipeName}'
  try {
    $ar = $pipe.BeginWaitForConnection($null, $null)
    while (-not $ar.AsyncWaitHandle.WaitOne(1000)) { if ((Get-Date) -ge $deadline -or -not (Tune-Open)) { break } }
    if (-not $ar.IsCompleted) { break }
    $pipe.EndWaitForConnection($ar)
    Open-TuneWriter $pipe
    $line = Read-TuneLine $pipe 10000
    if ($null -eq $line) { continue }
    try {
      $req = $line | ConvertFrom-Json
      $name = [string]$req.op
      if ($name -eq 'status') { $out = @{ ok = $true; data = @{ until = $until } } }
      elseif ($name -eq 'stop') { $out = @{ ok = $true; data = 'stopping' }; $deadline = Get-Date }
      else {
        $op = $ops[$name]
        if (-not $op) { throw 'unknown request' }
        $result = $null
        . $op
        $out = @{ ok = $true; data = $result }
      }
    } catch { $out = @{ ok = $false; error = $_.Exception.Message } }
    Send-Result $out
  } finally { $script:tuneWriter = $null; $pipe.Dispose() }
}
`;

// A few seconds of margin so a request never lands just as the helper exits.
const adminAlive = () => !!admin && admin.until - Date.now() > 4000;

async function startAdmin() {
  admin = null;
  const pipe = newPipeName('TuneAdmin');
  let started;
  try { started = await startElevated(adminHelper(pipe, process.pid)); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  if (!started.ok) return started;
  // Usually under a second; the first run can be slower while antivirus scans PowerShell.
  for (let i = 0; i < 200; i++) {
    const r = await pipeCall(pipe, { op: 'status' }, { timeoutMs: 5000, tries: 1 });
    if (r && r.ok && Number.isFinite(Number(r.data && r.data.until))) {
      admin = { pipe, until: Number(r.data.until) };
      return { ok: true };
    }
    await wait(150);
  }
  return { ok: false, error: 'admin helper did not start' };
}

async function adminCall(req, { timeoutMs = 30000, onProgress } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!adminAlive()) {
      const s = await startAdmin();
      if (!s.ok) return s;
    }
    const r = await pipeCall(admin.pipe, req, { timeoutMs, onProgress });
    if (r) return { ...r, adminUntil: adminStatus() };
    // nobody listens any more (the helper ended early): start a new one and send it again
    admin = null;
  }
  return { ok: false, error: 'admin helper did not answer' };
}

const adminStatus = () => (adminAlive() ? admin.until : 0);

// "Approve for 10 minutes" ahead of time, before starting a batch of work.
async function adminStart() {
  if (adminAlive()) return { ok: true, data: admin.until };
  const s = await startAdmin();
  return s.ok ? { ok: true, data: admin.until } : s;
}

// Ends the session: the helper is asked to stop (and stops by itself once Tune has closed).
function adminStop() {
  if (admin) pipeCall(admin.pipe, { op: 'stop' }, { timeoutMs: 3000, tries: 1 }).catch(() => {});
  admin = null;
}

module.exports = { wait, adminCall, adminStatus, adminStart, adminStop, adminHelper };
