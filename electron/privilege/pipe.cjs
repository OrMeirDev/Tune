// Talking to a privileged helper over a named pipe: the background service (\\.\pipe\TuneService)
// and the elevated admin session or one-off elevated script (a pipe of their own). One request per
// connection: a JSON line in; progress lines ({"progress": ...}) and then one result line out.
// Also the PowerShell pieces an elevated script uses to serve that same protocol (PIPE_SERVER_PS).
const net = require('net');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pipePath = (name) => `\\\\.\\pipe\\${name}`;

// Resolves to null when nothing listens on the pipe (so the caller can fall back), otherwise to the
// answer. A busy or momentarily missing pipe is retried briefly before giving up on it.
async function pipeCall(name, req, opts = {}) {
  const tries = opts.tries || 4;
  for (let attempt = 0; attempt < tries; attempt++) {
    const r = await pipeOnce(name, req, opts);
    if (r !== 'retry') return r;
    await wait(120);
  }
  return null;
}

function pipeOnce(name, req, { timeoutMs = 30000, onProgress } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let connected = false;
    let done = false;
    const sock = net.connect(pipePath(name));
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    // once the request was sent, a missing answer leaves its outcome unknown (it may have run): 'noAnswer'
    const timer = setTimeout(() => finish(connected ? { ok: false, error: 'no answer in time', code: 'noAnswer' } : null), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => { connected = true; sock.write(`${JSON.stringify(req)}\n`); });
    sock.on('error', (e) => finish(connected ? { ok: false, error: String(e.message || e), code: 'noAnswer' } : ['ENOENT', 'EBUSY'].includes(e.code) ? 'retry' : null));
    sock.on('close', () => finish(connected ? { ok: false, error: 'the connection closed without an answer', code: 'noAnswer' } : null));
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.progress) { if (onProgress) onProgress(m.progress); continue; }
        finish(m);
      }
    });
  });
}

// PowerShell for an elevated script that serves Tune over its own pipe. The pipe is open to the
// Windows account Tune runs as ($tuneUser, set by the script: with Windows' over-the-shoulder prompt a
// standard user's request runs elevated as an administrator's account, which is not the one that must
// connect), to the elevated account itself, and to SYSTEM and administrators; nobody else. One
// connection at a time. Reading the request has a deadline, so a client that connects and says
// nothing can't hold the helper. `Send-Line` never throws: if Tune went away, the work still finishes.
const PIPE_SERVER_PS = `
function New-TunePipe([string]$name) {
  $sec = New-Object IO.Pipes.PipeSecurity
  $users = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  if ($tuneUser) { $users += $tuneUser }
  foreach ($u in ($users | Select-Object -Unique)) {
    $sec.AddAccessRule((New-Object IO.Pipes.PipeAccessRule((New-Object Security.Principal.SecurityIdentifier($u)), [IO.Pipes.PipeAccessRights]::ReadWrite, [Security.AccessControl.AccessControlType]::Allow)))
  }
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $sec.AddAccessRule((New-Object IO.Pipes.PipeAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)))
  }
  New-Object IO.Pipes.NamedPipeServerStream($name, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536, $sec)
}
# One line (up to 64 KB) within $ms milliseconds, or $null.
function Read-TuneLine($stream, [int]$ms) {
  $buf = New-Object byte[] 65536; $n = 0; $end = [DateTime]::UtcNow.AddMilliseconds($ms)
  while ($n -lt $buf.Length) {
    $left = [int]($end - [DateTime]::UtcNow).TotalMilliseconds
    if ($left -le 0) { return $null }
    $ar = $stream.BeginRead($buf, $n, $buf.Length - $n, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($left)) { return $null }
    $got = $stream.EndRead($ar)
    if ($got -le 0) { return $null }
    $nl = [Array]::IndexOf($buf, [byte]10, $n, $got)
    $n += $got
    if ($nl -ge 0) { return [Text.Encoding]::UTF8.GetString($buf, 0, $nl) }
  }
  return $null
}
$script:tuneWriter = $null
function Send-Line([string]$line) { if ($script:tuneWriter) { try { $script:tuneWriter.WriteLine($line) } catch { $script:tuneWriter = $null } } }
function Open-TuneWriter($stream) {
  $script:tuneWriter = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding $false))
  $script:tuneWriter.AutoFlush = $true; $script:tuneWriter.NewLine = "\`n"
}
function Report-Progress($o) { Send-Line ('{"progress":' + ($o | ConvertTo-Json -Compress -Depth 6) + '}') }
function Send-Result($out) { Send-Line ($out | ConvertTo-Json -Depth 8 -Compress) }
`;

module.exports = { wait, pipePath, pipeCall, pipeOnce, PIPE_SERVER_PS };
