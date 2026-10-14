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
  console.log('BIOS not offered:', JSON.stringify(await js(`window.tune.biosDownload('bios')`)), '| downloads run:', downloads);
  console.log('malformed export:', JSON.stringify(await js(`window.tune.exportHardware('exe')`)));
  console.log('folder outside the scan:', JSON.stringify(await js(`window.tune.openFolder('C:\\Windows')`)));
  console.log('link not https:', JSON.stringify(await js(`window.tune.openLink('file:///C:/Windows/notepad.exe')`)));
  console.log('window.open:', await js(`String(window.open('https://example.com'))`), '| windows:', BrowserWindow.getAllWindows().length);
  await js(`location.href = 'https://example.com'`); await wait(1500);
  console.log('navigate away blocked:', win.webContents.getURL() === startUrl);
  console.log('inline script blocked by CSP:', await js(`(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.append(s); return window.__ran === undefined; })()`));
  console.log('page still works:', await js(`document.querySelectorAll('.nav-item').length`), 'nav items');
  app.exit(0);
});
