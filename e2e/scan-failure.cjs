// Audit TUN-03 in the real app: a failed check never shows "all up to date". Runs three scans with
// sample results (the Tune service pipe is refused, nothing on the PC changes), on the second monitor:
// 1) Windows Update fails, nothing else found -> "scan didn't finish", no animation, no chime;
// 2) the GPU check fails but a BIOS update exists -> the update shows, with a "not checked" note;
// 3) everything answers, nothing found -> the celebration, as before.
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
const out = OUT_DIR;
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'tune-fail-')));
app.on('window-all-closed', () => {});
const sys = require(path.join(tune, 'electron', 'system.cjs'));
let mode = 1;
const BIOS_OK = { ok: true, data: { supported: true, newer: false, maker: 'ASUS', model: 'PRIME Z790-P WIFI' } };
const BIOS_NEW = { ok: true, data: { supported: true, newer: true, maker: 'ASUS', model: 'PRIME Z790-P WIFI', site: 'asus.com', installed: '1836', latest: { version: '1901', date: '2026-10-01', size: '15 MB', url: 'https://dlcdnets.asus.com/x.zip' } } };
sys.driverUpdates = async () => (mode === 1 ? { ok: false, error: 'Windows Update service did not answer' } : { ok: true, data: [] });
sys.gpuVendorCheck = async () => (mode === 2 ? { ok: false, error: 'vendor site unreachable' } : { ok: true, data: [] });
sys.biosCheck = async () => (mode === 2 ? BIOS_NEW : BIOS_OK);
app.whenReady().then(async () => {
  require(path.join(tune, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => app.exit(1), 240000);
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript(`(() => { window.__chimes = 0; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__chimes++; return play.call(this); }; })()`));
  const js = (c) => win.webContents.executeJavaScript(c).catch(() => null);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  await js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`); await wait(200);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'עברית')?.click()`); await wait(200);
  await js(`document.querySelectorAll('.nav-item')[0].click()`);
  win.webContents.setZoomFactor(1); win.setContentSize(1347, 852);
  const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) win.setPosition(d.workArea.x + 40, d.workArea.y + 40);
  win.show();
  const shot = async (n) => { win.webContents.invalidate(); await wait(200); fs.writeFileSync(path.join(out, n), (await win.webContents.capturePage()).toPNG()); };
  const settle = async () => { await wait(800); while (await js(`!!document.querySelector('.dot-off')`)) await wait(300); await wait(2200); };
  const state = () => js(`({ allGood: !!document.querySelector('.all-good'), incomplete: document.querySelector('.scan-incomplete')?.innerText.replace(/\s+/g, ' ') || null, partial: document.querySelector('.partial-scan')?.innerText || null, banner: !!document.querySelector('.banner.err, .msg.err, [class*=banner][class*=err]'), rows: document.querySelectorAll('.panel .drow').length, chimes: window.__chimes })`);
  await settle();
  console.log('1 WU fails:', JSON.stringify(await state())); await shot('fail-1-wu.png');
  for (const m of [2, 3]) {
    mode = m;
    await js(`[...document.querySelectorAll('.page-header button.btn-primary, header button.btn-primary')][0]?.click()`);
    await settle();
    console.log(m === 2 ? '2 GPU fails + BIOS update:' : '3 all answer, nothing found:', JSON.stringify(await state())); await shot(`fail-${m}.png`);
  }
  app.exit(0);
});
