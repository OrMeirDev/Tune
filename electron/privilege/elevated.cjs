// Starting elevated PowerShell (after Windows' approval prompt) without anything a normal program
// could change on the way (audit TUN-02):
// - the script travels inside the command line Windows elevates (-EncodedCommand; gzip-compressed so
//   the admin catalog fits well under Windows' 32,767-character limit), never as a file in a folder
//   the user can write to, so it can't be swapped between writing and elevation;
// - the elevated process answers through a named pipe it creates itself (privilege/pipe.cjs), never
//   by writing files into the user's folders, so nothing it writes can be redirected by a link;
// - it loads PowerShell modules only from Windows PowerShell's own folder ($PSHOME\Modules, which only
//   administrators can change): by default the user's Documents\WindowsPowerShell\Modules comes first,
//   where any program running as the user could plant a module named like a built-in one (Set-Acl's,
//   say) that the elevated script would then load. Pinned first thing in the bootstrap and again in
//   the script (ELEVATED_PRELUDE).
const crypto = require('crypto');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const zlib = require('zlib');
const { PRELUDE, PS } = require('../infra/powershell.cjs');
const { pipeCall, wait, PIPE_SERVER_PS } = require('./pipe.cjs');

// Windows' limit for a whole command line; the elevated one must stay well below it.
const COMMAND_LINE_MAX = 32767;
const ELEVATED_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand'];

// The value of -EncodedCommand: a short bootstrap that decompresses `script` from inside the command
// line itself and runs it.
const PIN_MODULES = "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules');";
const ELEVATED_PRELUDE = `${PIN_MODULES}\n${PRELUDE}`;

function encodedCommand(script) {
  const gz = zlib.gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
  const boot = `${PIN_MODULES}$b=[Convert]::FromBase64String('${gz}');$m=New-Object IO.MemoryStream(,$b);`
    + '$z=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Decompress);'
    + '$s=(New-Object IO.StreamReader($z,[Text.Encoding]::UTF8)).ReadToEnd();. ([ScriptBlock]::Create($s))';
  const enc = Buffer.from(boot, 'utf16le').toString('base64');
  if (enc.length + 200 > COMMAND_LINE_MAX) throw new Error('elevated script too long for a command line');
  return enc;
}

// The arguments the elevated PowerShell is started with (no -File: nothing is read from disk).
const elevatedArgs = (script) => [...ELEVATED_ARGS, encodedCommand(script)];

// Asks Windows to run `script` elevated (the approval prompt) and returns once it has started, or
// { ok: false, error: 'cancelled' } when the prompt was declined.
function startElevated(script) {
  const list = elevatedArgs(script).map((a) => `'${a}'`).join(',');
  return new Promise((resolve) => {
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `try { Start-Process -FilePath '${PS}' -ArgumentList ${list} -Verb RunAs -WindowStyle Hidden; exit 0 } catch { exit 1223 }`], { windowsHide: true });
    child.on('error', (e) => resolve({ ok: false, error: `could not start PowerShell: ${e.message}` }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: 'cancelled' }));
  });
}

const newPipeName = (prefix) => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;

// The Windows account Tune runs as, which the elevated helper's pipe must let in (see PIPE_SERVER_PS);
// null when it can't be read (the pipe then admits the elevated account only, as before).
const SID = /^S-1-[0-9]+(-[0-9]+)+$/;
let requester;
function requesterSid() {
  if (requester !== undefined) return requester;
  try {
    const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const m = /"(S-1-[0-9-]+)"\s*$/.exec(out.trim());
    requester = m && SID.test(m[1]) ? m[1] : null;
  } catch { requester = null; }
  return requester;
}
const userLine = (sid) => `$tuneUser = ${sid && SID.test(sid) ? `'${sid}'` : '$null'}\n`;

// A one-off elevated script (one approval prompt, then it exits), for installing or removing the
// service: `body` runs with Report-Progress and leaves its answer in $result. It serves exactly one
// connection on its own pipe; Tune connects, asks it to run, and reads progress and the result.
const oneShotScript = (pipeName, body, sid = null) => `${ELEVATED_PRELUDE}${userLine(sid)}${PIPE_SERVER_PS}
$pipe = New-TunePipe '${pipeName}'
try {
  $ar = $pipe.BeginWaitForConnection($null, $null)
  if (-not $ar.AsyncWaitHandle.WaitOne(120000)) { exit 1 }
  $pipe.EndWaitForConnection($ar)
  Open-TuneWriter $pipe
  $line = Read-TuneLine $pipe 10000
  if ($line -ne '{"op":"run"}') { exit 1 }
  try {
${body}
    $out = @{ ok = $true; data = $result }
  } catch { $out = @{ ok = $false; error = $_.Exception.Message } }
  Send-Result $out
} finally { $pipe.Dispose() }
`;

async function runElevated(body, { timeoutMs = 10 * 60 * 1000, onProgress } = {}) {
  const pipeName = newPipeName('TuneElevated');
  let started;
  try { started = await startElevated(oneShotScript(pipeName, body, requesterSid())); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  if (!started.ok) return started;
  // PowerShell starts and opens its pipe within a few seconds (longer while antivirus scans it)
  for (let i = 0; i < 200; i++) {
    const r = await pipeCall(pipeName, { op: 'run' }, { timeoutMs, onProgress, tries: 1 });
    if (r) return r;
    await wait(150);
  }
  return { ok: false, error: 'the elevated step did not start' };
}

module.exports = { COMMAND_LINE_MAX, ELEVATED_PRELUDE, encodedCommand, elevatedArgs, startElevated, newPipeName, requesterSid, userLine, oneShotScript, runElevated };
