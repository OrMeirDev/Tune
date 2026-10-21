// The "all up to date" celebration: frames of the animation, and how many times the chime plays
// (once per finished scan, and not again when coming back to the page). The driver search returns
// nothing to install; the Tune service pipe is never reached.
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
const toSecondScreen = (w) => { const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) w.setPosition(d.workArea.x + 40, d.workArea.y + 40); };
const path = require('path');
const fs = require('fs');
const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output', path.basename(__filename, '.cjs'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const tune = APP_DIR;
const out = OUT_DIR;
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'e2e-')));
app.on('window-all-closed', () => {});
const sys = require(path.join(tune, 'electron', 'system.cjs'));
// The celebration needs a completed hardware check. Keep that input deterministic off Windows,
// just as the driver/vendor checks below; a host without PowerShell must not decide this UI test.
sys.scanHardware = async () => ({ ok: true, data: { ...require('./ui-samples.cjs').hardware, gpus: [], devices: [], problems: [] } });
sys.driverUpdates = async () => ({ ok: true, data: [] });
sys.biosCheck = async () => ({ ok: true, data: { supported: true, newer: false, maker: 'ASUS', model: 'PRIME Z790-P WIFI' } });
sys.gpuVendorCheck = async () => ({ ok: true, data: [] });
const failures = [];
const check = (name, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got)})` : ''}`); if (!cond) failures.push(name); };
const finish = () => { console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED'); app.exit(failures.length ? 1 : 0); };

app.whenReady().then(async () => {
  require(path.join(tune, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => app.exit(1), 120000);
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  // Count the chimes: every AudioContext the page creates.
  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript(`(() => { window.__chimes = 0; window.__src = ''; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__chimes++; window.__src = this.src; return play.call(this); }; })()`));
  const js = (c) => win.webContents.executeJavaScript(c).catch(() => null);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  await js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`); await wait(200);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'עברית')?.click()`); await wait(200);
  await js(`document.querySelectorAll('.nav-item')[0].click()`);
  win.webContents.setZoomFactor(1); win.setContentSize(1347, 852); toSecondScreen(win);
  while (!(await js(`!!document.querySelector('.all-good')`))) await wait(30);
  const shot = async (name) => { win.webContents.invalidate(); fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG()); };
  const start = Date.now();
  for (const ms of [350, 800, 1050, 1300, 2200, 2900, 3600]) { await wait(ms - (Date.now() - start)); await shot(`allgood-${ms}.png`); }
  check('one chime when the finished scan is first shown', (await js('window.__chimes')) === 1, await js('window.__src'));
  await js(`document.querySelectorAll('.nav-item')[2].click()`); await wait(500);
  await js(`document.querySelectorAll('.nav-item')[0].click()`); await wait(2000);
  check('no second chime when coming back to the page', (await js('window.__chimes')) === 1);
  finish();
});
