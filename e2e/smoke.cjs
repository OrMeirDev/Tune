// Every page of Tune renders without a runtime error (service pipe refused, throwaway profile,
// second monitor). Prints each page's heading and any renderer error.
const net = require('net');
const { EventEmitter } = require('events');
const realConnect = net.connect;
net.connect = (...a) => {
  if (!String(a[0]).includes('pipe')) return realConnect(...a);
  const fake = new EventEmitter();
  Object.assign(fake, { setEncoding() {}, write() {}, destroy() {} });
  setImmediate(() => fake.emit('error', Object.assign(new Error('blocked in test'), { code: 'ECONNREFUSED' })));
  return fake;
};
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const tune = APP_DIR;
const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tune-smoke-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
// The guide is conditional on CPU family and startup entries vary by image. Explicit SYNTHETIC
// read-only fixtures keep these UI checks independent of the runner's hardware and registry.
const sys = require(path.join(tune, 'electron', 'system.cjs'));
let recommendationsFail = true;
const sampleRecommendations = async () => ({ ok: true, data: [
  { key: 'powerLimit', group: 'cpu', cpuKind: 'intelHybrid', intel1314: true, ok: null, guide: 'powerLimit' },
] });
sys.recommendations = async () => recommendationsFail ? { ok: false, error: 'SAMPLE first-read failure' } : sampleRecommendations();
sys.startupList = async () => ({ ok: true, data: [
  { source: 'HKCU', key: 'TuneSmokeSample', name: 'SAMPLE startup item (not executed)', enabled: true, admin: false },
] });
for (const name of ['installDrivers', 'downloadGpuInstaller', 'downloadBios', 'enableDevice', 'junkClean', 'startupToggle', 'applyRecommendation', 'createRestorePoint', 'installService', 'uninstallService', 'adminStart'])
  sys[name] = async () => { throw new Error('machine changes are blocked in smoke: ' + name); };
const run = require('./harness.cjs').createRun({ exit: code => app.exit(code) });
const check = run.check;
run.onCleanup(() => require('child_process').spawn('node', ['-e', 'setTimeout(() => require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }), 3000)', profile], { detached: true, stdio: 'ignore', windowsHide: true }).unref());

run.guard(async () => {
  run.timeout(240000);
  await app.whenReady();
  require(path.join(tune, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('render-process-gone', (e, d) => errors.push('renderer gone: ' + d.reason));
  const js = (c) => win.webContents.executeJavaScript(c).catch((e) => 'JS-ERR ' + e.message);
  win.webContents.setZoomFactor(1); win.setContentSize(1347, 852);
  const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) win.setPosition(d.workArea.x + 40, d.workArea.y + 40);
  win.show(); win.focus();
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  for (let i = 0; i < 180 && (await js(`!!document.querySelector('.dot-off')`)); i++) await wait(1000);
  const n = await js(`document.querySelectorAll('.nav-item').length`);
  for (let i = 0; i < n; i++) {
    await js(`document.querySelectorAll('.nav-item')[${i}].click()`); await wait(1800);
    const r = await js(`({ h1: document.querySelector('.main h1')?.textContent || '(no heading)', len: document.querySelector('.main')?.innerText.length || 0 })`);
    check(`page ${i} renders (${r.h1})`, r.h1 !== '(no heading)' && r.len > 50, r.len);
  }
  // the dialogs: power-limit guide from the performance center
  await js(`[...document.querySelectorAll('.nav-item')].find((b) => /מרכז ביצועים|Performance center/.test(b.textContent))?.click()`); await wait(1500);
  const retry = await js(`({ failed: !!document.querySelector('.scan-failed'), enabled: document.querySelector('header .btn-ghost')?.disabled === false })`);
  check('a failed first recommendation read is explicit and retry stays available', retry?.failed && retry?.enabled, retry);
  recommendationsFail = false;
  await js(`document.querySelector('header .btn-ghost')?.click()`); await wait(1000);
  check('retry recovers the recommendation page without a restart', await js(`!document.querySelector('.scan-failed') && [...document.querySelectorAll('button')].some(b => /איך עושים|How to/.test(b.textContent))`));
  await js(`[...document.querySelectorAll('button')].find((b) => /איך עושים|How to/.test(b.textContent))?.click()`); await wait(600);
  check('the power-limit guide opens', (await js(`document.querySelector('.modal h2')?.textContent || ''`)).length > 0);
  const a11y = await js(`({ role: document.querySelector('.modal')?.getAttribute('role'), labelled: !!document.getElementById(document.querySelector('.modal')?.getAttribute('aria-labelledby') || 'x'), focusInside: !!document.querySelector('.modal')?.contains(document.activeElement) })`);
  check('the dialog is a labelled dialog with focus inside', a11y.role === 'dialog' && a11y.labelled && a11y.focusInside, a11y);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(400);
  check('Escape closes it', !(await js(`!!document.querySelector('.modal')`)));
  await js(`[...document.querySelectorAll('.nav-item')].find((b) => /Startup apps|הפעלה עם Windows/.test(b.textContent))?.click()`); await wait(1200);
  const sw = await js(`[[...document.querySelectorAll('.toggle')].length, [...document.querySelectorAll('[role=switch][aria-checked]')].length]`);
  check('every startup switch is a labelled switch', sw[0] > 0 && sw[0] === sw[1], sw);
  check('no renderer errors', errors.length === 0, errors);
});
