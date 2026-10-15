// Every PowerShell script Tune generates parses without errors (Windows only): the read-only scans,
// the user-level actions, the fixed admin operations and the scripts the service and the admin
// session run. Nothing is executed: runPS and the privileged call are replaced by recorders, and
// PowerShell's own parser checks each recorded script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EL = path.join(__dirname, '..', 'electron');
const scripts = new Map();
const ps = require(path.join(EL, 'infra', 'powershell.cjs'));
ps.runPS = (body) => { scripts.set(`runPS #${scripts.size + 1}: ${body.trim().split('\n')[0].slice(0, 60)}`, `${ps.PRELUDE || ''}try {\n${body}\n} catch {}`); return Promise.resolve({ ok: true, data: [] }); };
const service = require(path.join(EL, 'privilege', 'service.cjs'));
service.privileged = () => Promise.resolve({ ok: true, data: {} });
service.serviceCall = () => Promise.resolve({ ok: false, error: 'test' });

test('every generated PowerShell script parses', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, async () => {
  const f = (m) => require(path.join(EL, 'features', m));
  await f('hardware.cjs').scanHardware();
  await f('drivers.cjs').driverUpdates();
  await f('cleanup.cjs').junkScan();
  await f('cleanup.cjs').junkClean(['userTemp', 'thumbs']);
  await f('startup.cjs').startupList();
  await f('startup.cjs').startupToggle('HKCU', "It's \"quoted\"", true);
  await f('recommendations.cjs').recommendations();
  await f('recommendations.cjs').applyRecommendation('power');
  await f('recommendations.cjs').applyRecommendation('gamemode');
  await f('sensors.cjs').performance();
  await f('measurements.cjs').bootInfo();
  await require(path.join(EL, 'licensing', 'identity.cjs')).readMachineId(ps.runPS);
  const ops = require(path.join(EL, 'privilege', 'operations.cjs'));
  scripts.set('ops table (admin operations)', `${ops.STARTUP}${ops.JUNK}${ops.OPS_TABLE()}`);
  scripts.set('service ops.ps1', service.serviceOpsScript());
  scripts.set('admin session helper', require(path.join(EL, 'privilege', 'admin-session.cjs')).adminHelper('TuneAdmin-0123456789abcdef01234567', 4242));
  const { oneShotScript } = require(path.join(EL, 'privilege', 'elevated.cjs'));
  const manifest = { version: '6', id: 'abcdef012345', files: { 'TuneService.exe': 'A'.repeat(64), 'ops.ps1': 'B'.repeat(64) } };
  scripts.set('service install (elevated)', oneShotScript('TuneElevated-x', service.installScript("C:\\Users\\O'Brien\\Tune\\resources\\service", manifest)));
  scripts.set('service removal (elevated)', oneShotScript('TuneElevated-x', service.uninstallScript()));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-ps-parse-'));
  const names = [...scripts.keys()];
  names.forEach((n, i) => fs.writeFileSync(path.join(dir, `${i}.ps1`), scripts.get(n), 'utf8'));
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-ChildItem '${dir}' -Filter *.ps1 | ForEach-Object { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e); [pscustomobject]@{ i = [int]$_.BaseName; errors = @($e | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }) } } | ConvertTo-Json -Depth 3 -Compress`,
  ], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  const results = [].concat(JSON.parse(out));
  assert.ok(names.length >= 15, `only ${names.length} scripts captured`);
  assert.equal(results.length, names.length);
  for (const r of results) assert.deepEqual(r.errors, [], `${names[r.i]}:\n${r.errors.join('\n')}`);
});
