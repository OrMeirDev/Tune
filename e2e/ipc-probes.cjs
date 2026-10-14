// The locked connection in the real app (service pipe refused, throwaway profile, second monitor).
// Only harmless probes: nothing here can change the PC even if a check failed.
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
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'tune-ipc-')));
app.on('window-all-closed', () => {});
const sys = require(path.join(tune, 'electron', 'system.cjs'));
let downloads = 0;
sys.downloadBios = async () => { downloads++; return { ok: true, data: 'x' }; };
sys.biosCheck = async () => ({ ok: true, data: { supported: true, newer: false, maker: 'ASUS' } }); // nothing newer offered
const failures = [];
const check = (name, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${got !== undefined ? ` (${JSON.stringify(got)})` : ''}`); if (!cond) failures.push(name); };
const finish = () => { console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED'); app.exit(failures.length ? 1 : 0); };

app.whenReady().then(async () => {
  require(path.join(tune, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 200000);
  let win; while (!(win = BrowserWindow.getAllWindows()[0])) await wait(20);
  const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id); if (d) win.setPosition(d.workArea.x + 40, d.workArea.y + 40);
  win.show();
  const js = (c) => win.webContents.executeJavaScript(c).catch((e) => 'JS-ERR ' + e.message);
  while (!(await js(`document.querySelectorAll('.nav-item').length`))) await wait(50);
  for (let i = 0; i < 180 && (await js(`!!document.querySelector('.dot-off')`)); i++) await wait(1000);
  const startUrl = win.webContents.getURL();
  const bios = await js(`window.tune.biosDownload('bios')`);
  check('a BIOS that was not offered is refused, nothing downloaded', bios?.ok === false && downloads === 0, bios);
  const exp = await js(`window.tune.exportHardware('exe')`);
  check('a malformed request is refused', exp?.ok === false && exp.error === 'invalid request', exp);
  check('a folder outside the scan is not opened', (await js(`window.tune.openFolder('C:\\Windows')`)) == null);
  const link = await js(`window.tune.openLink('file:///C:/Windows/notepad.exe')`);
  check('a non-https link is refused', link?.ok === false, link);
  const opened = await js(`String(window.open('https://example.com'))`);
  check('window.open is blocked', opened === 'null' && BrowserWindow.getAllWindows().length === 1, opened);
  await js(`location.href = 'https://example.com'`); await wait(1500);
  check('navigating away is blocked', win.webContents.getURL() === startUrl);
  check('an injected inline script is blocked by the CSP', await js(`(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.append(s); return window.__ran === undefined; })()`));
  check('the page still works', (await js(`document.querySelectorAll('.nav-item').length`)) > 5);
  finish();
});
