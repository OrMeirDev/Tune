// Builds the background service into service/bin (bundled with the app as resources/service):
// - LibreHardwareMonitor 0.9.6 (official .NET Framework release, pinned by hash): only the library
//   and the files it needs, plus its MPL-2.0 license;
// - TuneService.exe, compiled with the C# compiler that ships with Windows (.NET Framework 4.8), with
//   its version from electron/privilege/service-version.cjs (the one the app expects);
// - ops.ps1, generated from the same operations Tune runs through the admin session;
// - electron/privilege/service-manifest.json (packed into the app): the SHA-256 of every file above,
//   which the elevated installer checks each copy against inside Program Files (audit TUN-02).
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'service', 'bin');
const LHM = {
  url: 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip',
  sha256: '086D9F1B5A99E643EDC2CFAAAC16051685B551E4C5AC0B32A57C58C0E529C001',
  license: 'https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/v0.9.6/LICENSE',
  licenseSha256: '1F256ECAD192880510E84AD60474EAB7589218784B9A50BC7CEEE34C2B91F1D5',
  // LibreHardwareMonitorLib.dll and everything it loads; the app's own UI files are left out.
  files: ['LibreHardwareMonitorLib.dll', 'HidSharp.dll', 'BlackSharp.Core.dll', 'DiskInfoToolkit.dll', 'RAMSPDToolkit-NDD.dll',
    'System.Buffers.dll', 'System.Memory.dll', 'System.Numerics.Vectors.dll', 'System.Runtime.CompilerServices.Unsafe.dll',
    'System.Security.AccessControl.dll', 'System.Security.Principal.Windows.dll', 'System.Threading.AccessControl.dll'],
};

const version = require('../electron/privilege/service-version.cjs');

// The C# side of the one version number.
const buildInfo = (v) => {
  if (!/^\d+$/.test(v)) throw new Error(`serviceVersion must be a whole number, not ${v}`);
  return `namespace Tune { static class BuildInfo { public const string Version = "${v}"; } }\n`;
};

// Every file the service folder gets, with its SHA-256 (upper-case hex, as Get-FileHash prints it),
// and an id for this exact set (a new folder per build in Program Files).
function manifestOf(dir, v) {
  const files = {};
  for (const name of fs.readdirSync(dir).filter((n) => /\.(exe|dll|ps1|txt)$/i.test(n)).sort()) {
    files[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex').toUpperCase();
  }
  const id = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  return { version: v, id, files };
}

async function download(url, sha256) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  if (hash !== sha256) throw new Error(`${url}: unexpected file (sha256 ${hash})`);
  return buf;
}

async function fetchLibreHardwareMonitor() {
  if (LHM.files.every((f) => fs.existsSync(path.join(out, f))) && fs.existsSync(path.join(out, 'LibreHardwareMonitor-LICENSE.txt'))) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lhm-'));
  fs.writeFileSync(path.join(tmp, 'lhm.zip'), await download(LHM.url, LHM.sha256));
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${path.join(tmp, 'lhm.zip')}' -DestinationPath '${path.join(tmp, 'x')}' -Force`]);
  for (const f of LHM.files) fs.copyFileSync(path.join(tmp, 'x', f), path.join(out, f));
  fs.writeFileSync(path.join(out, 'LibreHardwareMonitor-LICENSE.txt'), await download(LHM.license, LHM.licenseSha256));
  fs.rmSync(tmp, { recursive: true, force: true });
}

(async () => {
  if (require.main !== module) return;
  fs.mkdirSync(out, { recursive: true });
  // Left over from the first version, which read the CPU through its own PawnIO module.
  for (const f of ['IntelMSR.bin', 'PawnIO-modules-COPYING.txt']) fs.rmSync(path.join(out, f), { force: true });
  await fetchLibreHardwareMonitor();
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const gen = fs.mkdtempSync(path.join(os.tmpdir(), 'tune-service-'));
  fs.writeFileSync(path.join(gen, 'BuildInfo.g.cs'), buildInfo(version));
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${path.join(out, 'TuneService.exe')}`,
    '/r:System.ServiceProcess.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll',
    ...LHM.files.map((f) => `/r:${path.join(out, f)}`), path.join(root, 'service', 'TuneService.cs'), path.join(gen, 'BuildInfo.g.cs')], { stdio: 'inherit' });
  fs.rmSync(gen, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'ops.ps1'), '\ufeff' + require('../electron/system.cjs').serviceOpsScript(), 'utf8');
  const manifest = manifestOf(out, version);
  fs.writeFileSync(path.join(root, 'electron', 'privilege', 'service-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`service ${version} built (${manifest.id}):`, Object.keys(manifest.files).join(', '));
})().catch((e) => { console.error(e.message || e); process.exit(1); });

module.exports = { buildInfo, manifestOf };
