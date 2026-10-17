// A failed check is never shown as fine, in the real app (audit TUN-03/TUN-16 and the 1.3.0 recheck
// R1–R4). Runs five scans with sample results in the real failure shapes (the Tune service pipe is
// refused, nothing on the PC changes), on the second monitor, and exits non-zero if any expectation
// fails:
// 1) Windows Update fails            -> "scan didn't finish", no chime, up-to-date count "—" (R4)
// 2) the ASUS catalog fails          -> "scan didn't finish", no celebration (R2)
// 3) NVIDIA check fails (per-card error, outer ok) + a BIOS update -> update shown with "not checked" (R1)
// 4) cleanup and startup scans fail  -> "not checked" on the overview, the center and the pages (R3)
// 5) everything answers, nothing found -> the celebration, one chime
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
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'tune-fail-')));
app.on('window-all-closed', () => {});

const sys = require(path.join(APP_DIR, 'electron', 'system.cjs'));
let mode = 1;
const BIOS_OK = { ok: true, data: { supported: true, newer: false, maker: 'ASUS', model: 'PRIME Z790-P WIFI' } };
const BIOS_NEW = { ok: true, data: { supported: true, newer: true, maker: 'ASUS', model: 'PRIME Z790-P WIFI', site: 'asus.com', installed: '1836', latest: { version: '1901', date: '2026-10-01', size: '15 MB', url: 'https://dlcdnets.asus.com/x.zip' } } };
// The same sample PC everywhere: a real hardware scan would add this PC's own cards and devices with
// driver problems (a CI runner's virtual hardware has some) to what each step expects.
const HARDWARE = { ok: true, data: {
  amdSoftware: null, systemMaker: 'ASUS', systemModel: 'Sample PC', systemSku: null, computer: 'ASUS Sample PC',
  board: 'ASUSTeK COMPUTER INC. PRIME Z790-P WIFI', boardMaker: 'ASUSTeK COMPUTER INC.', boardModel: 'PRIME Z790-P WIFI',
  bios: { version: '1836', date: '2025-01-01' }, cpu: 'Intel(R) Core(TM) i7-14700K', ramGB: 32,
  gpus: [{ name: 'NVIDIA GeForce RTX 4070', driverVersion: '32.0.15.6094', pnp: 'PCI\\VEN_10DE&DEV_2786' }], devices: [], problems: [],
} };
sys.scanHardware = async () => HARDWARE;
const realJunk = sys.junkScan;
const realStartup = sys.startupList;
sys.driverUpdates = async () => (mode === 1 ? { ok: false, error: 'Windows Update service did not answer' } : { ok: true, data: [] });
// the real failure shape: the adapter answers, and the card carries the error (R1)
sys.gpuVendorCheck = async (gpus) => ({ ok: true, data: (gpus || []).map((g) => (mode === 3 ? { status: 'error', gpu: g.name, vendor: 'NVIDIA', error: 'catalog unavailable' } : { status: 'ok', gpu: g.name, vendor: 'AMD', newer: false })) });
sys.biosCheck = async () => (mode === 3 ? BIOS_NEW : mode === 2 ? { ok: false, error: 'ASUS BIOS list unavailable' } : BIOS_OK);
sys.junkScan = async () => (mode === 4 ? { ok: false, error: 'scan failed' } : realJunk());
sys.startupList = async () => (mode === 4 ? { ok: false, error: 'scan failed' } : realStartup());

const failures = [];
const check = (name, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got)})` : ''}`); if (!cond) failures.push(name); };

app.whenReady().then(async () => {
  require(path.join(APP_DIR, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => { console.log('FAIL timeout'); app.exit(1); }, 300000);
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript(`(() => { window.__chimes = 0; const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__chimes++; return play.call(this); }; })()`));
  const js = (c) => win.webContents.executeJavaScript(c).catch(() => null);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  await js(`[...document.querySelectorAll('.nav-item')].at(-1).click()`); await wait(200);
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'English')?.click()`); await wait(200);
  await js(`document.querySelectorAll('.nav-item')[0].click()`);
  win.webContents.setZoomFactor(1); win.setContentSize(1347, 852);
  const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) win.setPosition(d.workArea.x + 40, d.workArea.y + 40);
  win.show();
  const shot = async (n) => { win.webContents.invalidate(); await wait(200); fs.writeFileSync(path.join(OUT_DIR, n), (await win.webContents.capturePage()).toPNG()); };
  const settle = async () => { await wait(800); while (await js(`!!document.querySelector('.dot-off')`)) await wait(300); await wait(2200); };
  const go = (re) => js(`[...document.querySelectorAll('.nav-item')].find((b) => ${re}.test(b.textContent))?.click()`);
  const updates = () => js(`({ allGood: !!document.querySelector('.all-good'), incomplete: !!document.querySelector('.scan-incomplete'), partial: !!document.querySelector('.partial-scan'), rows: document.querySelectorAll('.panel .drow').length, upToDate: document.querySelectorAll('.stats.tiled .stat b')[2]?.textContent, chimes: window.__chimes })`);
  const rescan = async () => { await go('/^Updates/'); await wait(500); await js(`document.querySelector('header .btn-primary')?.click()`); await settle(); };

  await settle();
  let u = await updates();
  check('1 Windows Update fails: no celebration', !u.allGood, u);
  check('1 Windows Update fails: "scan didn\'t finish"', u.incomplete);
  check('1 Windows Update fails: up-to-date count is unknown (R4)', u.upToDate === '—', u.upToDate);
  check('1 Windows Update fails: no chime', u.chimes === 0);
  await shot('1-wu-fails.png');

  mode = 2; await rescan(); u = await updates();
  check('2 ASUS catalog fails: no celebration (R2)', !u.allGood, u);
  check('2 ASUS catalog fails: "scan did not finish"', u.incomplete);
  await shot('2-asus-fails.png');

  mode = 3; await rescan(); u = await updates();
  check('3 NVIDIA fails + BIOS update: no celebration (R1)', !u.allGood, u);
  check('3 NVIDIA fails + BIOS update: the update is shown', u.rows === 1);
  check('3 NVIDIA fails + BIOS update: "not checked" note', u.partial);
  await shot('3-gpu-fails.png');

  mode = 4; await rescan();
  await go('/^Overview/'); await wait(1200);
  const ov = await js(`[...document.querySelectorAll('.ocard .ohead')].map((h) => h.textContent)`);
  check('4 cleanup/startup fail: overview shows "—", not a size or a count (R3)', ov && ov.some((t) => /cleanups*—/i.test(t)) && ov.some((t) => /Windowss*—/.test(t)), ov);
  await go('/^Performance center/'); await wait(1500);
  const rows = await js(`[...document.querySelectorAll('.drow')].map((r) => r.textContent).filter((t) => /Leftover|Startup apps|not checked/.test(t))`);
  check('4 cleanup/startup fail: the center says "not checked" (R3)', rows && rows.filter((t) => /not checked/.test(t)).length >= 2, rows);
  await go('/^Cleanup/'); await wait(800);
  check('4 cleanup/startup fail: the cleanup page says the scan failed', await js(`!!document.querySelector('.scan-failed')`));
  await shot('4-optional-scans-fail.png');

  // scan 4's driver checks all answered, so it celebrated too; count only this scan's chime
  const before = (await updates()).chimes;
  mode = 5; await rescan(); u = await updates();
  check('5 everything answers: the celebration', u.allGood, u);
  check('5 everything answers: one chime for this scan', u.chimes - before === 1, u.chimes - before);
  await shot('5-all-good.png');

  console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
