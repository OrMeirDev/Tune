// The admin session: one UAC prompt covers the next 10 minutes of admin operations (used when the
// background service is not installed).
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PRELUDE, PS } = require('../infra/powershell.cjs');
const { JUNK, OPS_TABLE, STARTUP } = require('./operations.cjs');

// One UAC approval starts an elevated helper that serves Tune for the next 10 minutes, so
// installing several drivers or flipping several switches asks once. It runs only the fixed
// operations below, checks every request itself (the folder it reads belongs to the normal
// user), and finishes an operation that is still running when the 10 minutes end.
const ADMIN_WINDOW_S = 10 * 60;

let admin = null; // { dir }

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
    child.on('error', (e) => { admin = null; fs.rm(dir, { recursive: true, force: true }, () => {}); resolve({ ok: false, error: `could not start PowerShell: ${e.message}` }); });
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

module.exports = { wait, adminCall, adminStatus, adminStart, adminStop, adminHelper };
