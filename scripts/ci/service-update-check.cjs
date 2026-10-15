// Service updates on a disposable Windows CI runner (audit TUN-12), after the installer has set up
// the service: an update whose new version never starts is rolled back to the version that was
// running, and the update's folder is removed. The broken update is a real bundle whose
// TuneService.exe is replaced by a program that isn't a service (with a manifest that matches it, so
// it passes the file check and fails only at start). Run as `node service-update-check.cjs <bundle>`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') { console.log('runs only on a disposable CI runner'); process.exit(2); }
const { installService, SERVICE_VERSION } = require('../../electron/privilege/service.cjs');
const { manifestOf } = require('../build-service.cjs');

const failures = [];
const check = (name, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got).slice(0, 400)})` : ''}`);
  if (!cond) failures.push(name);
};
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim();
const binPath = () => ps("(Get-CimInstance Win32_Service -Filter \"Name='TuneService'\").PathName");
const folders = () => ps("Get-ChildItem -LiteralPath (Join-Path $env:ProgramFiles 'Tune Service') -Directory | ForEach-Object Name").split(/\r?\n/).filter(Boolean).sort();
const version = () => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'pipe-call.cjs'), 'version'], { encoding: 'utf8' }).trim());

(async () => {
  const bundle = process.argv[2];
  const running = binPath();
  const before = folders();
  check('the service runs before the update', version().ok && version().data.version === SERVICE_VERSION, running);

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-broken-service-'));
  for (const f of fs.readdirSync(bundle)) fs.copyFileSync(path.join(bundle, f), path.join(broken, f));
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(broken, 'TuneService.exe'));
  const manifest = manifestOf(broken, SERVICE_VERSION);
  const started = Date.now();
  const r = await installService(broken, null, { manifest });
  console.log(`  (update attempt took ${Math.round((Date.now() - started) / 1000)} s)`);
  check('an update whose service never starts fails, and says the previous version was restored', r.ok === false && /did not start; the previous version was restored/.test(r.error || ''), r);
  check('the service points at the version that was running', binPath() === running, { before: running, after: binPath() });
  const v = version();
  check('and that version answers again', v.ok && v.data.version === SERVICE_VERSION, v);
  check("the failed update's folder is gone; the others are as they were", JSON.stringify(folders()) === JSON.stringify(before), { before, after: folders() });
  fs.rmSync(broken, { recursive: true, force: true });

  console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`FAIL unexpected error: ${e.stack || e}`); console.log('1 FAILED (stopped before the end)'); process.exit(1); });
