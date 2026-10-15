// Licensing at Tune's start, each time a new app process with a new profile (WIN-R01): three
// ordinary starts (timed: how long the licence row and the identity read take while the app's own
// start-up scans run), one where the identity read is slow, and one where it fails
// (e2e/licensing-startup-run.cjs). Passes only when every start passed. Nothing on the PC changes.
// Usage: node e2e/licensing-startup.cjs [mode ...]   (default: real real real slow fail)
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['real', 'real', 'real', 'slow', 'fail'];
// Chromium refuses to run as root with its sandbox (a Linux container); on Windows nothing is added
const extra = process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];
const failed = [];
for (const [i, mode] of modes.entries()) {
  console.log(`--- start ${i + 1}/${modes.length}: ${mode}`);
  const r = spawnSync(electron, [...extra, path.join(__dirname, 'licensing-startup-run.cjs'), mode], { encoding: 'utf8', timeout: 150000, env: process.env });
  process.stdout.write(r.stdout || '');
  if (r.stderr && r.status !== 0) process.stdout.write(r.stderr.split('\n').filter((l) => !/^\s*$/.test(l)).slice(-15).join('\n') + '\n');
  if (r.status !== 0) failed.push(`${i + 1} ${mode} (exit ${r.status ?? r.signal})`);
}
console.log(failed.length ? `FAILED starts: ${failed.join(', ')}` : `ALL ${modes.length} STARTS PASSED`);
process.exit(failed.length ? 1 : 0);
