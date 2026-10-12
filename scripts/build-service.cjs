// Builds the background service into service/bin (bundled with the app as resources/service):
// - LibreHardwareMonitor 0.9.6 (official .NET Framework release, pinned by hash): only the library
//   and the files it needs, plus its MPL-2.0 license;
// - TuneService.exe, compiled with the C# compiler that ships with Windows (.NET Framework 4.8);
// - ops.ps1, generated from the same operations Tune runs through the admin session.
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
  fs.mkdirSync(out, { recursive: true });
  // Left over from the first version, which read the CPU through its own PawnIO module.
  for (const f of ['IntelMSR.bin', 'PawnIO-modules-COPYING.txt']) fs.rmSync(path.join(out, f), { force: true });
  await fetchLibreHardwareMonitor();
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${path.join(out, 'TuneService.exe')}`,
    '/r:System.ServiceProcess.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll',
    ...LHM.files.map((f) => `/r:${path.join(out, f)}`), path.join(root, 'service', 'TuneService.cs')], { stdio: 'inherit' });
  fs.writeFileSync(path.join(out, 'ops.ps1'), '\ufeff' + require('../electron/system.cjs').serviceOpsScript(), 'utf8');
  console.log('service built:', fs.readdirSync(out).join(', '));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
