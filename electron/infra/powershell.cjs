// Running PowerShell as the user: every read-only question Tune asks Windows is a script that leaves
// its answer in $result, returned as parsed JSON.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS =path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const PRELUDE = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;\n";

function tempFile(ext) {
  return path.join(os.tmpdir(), `tune-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

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

module.exports = { PS, PRELUDE, tempFile, runPS };
