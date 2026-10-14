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
app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'tune-smoke-')));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  require(path.join(tune, 'electron', 'main.cjs'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(() => { console.log('TIMEOUT'); app.exit(1); }, 240000);
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
    console.log(`page ${i}: ${r.h1} · ${r.len} chars`);
  }
  // the dialogs: power-limit guide from the performance center
  await js(`[...document.querySelectorAll('.nav-item')].find((b) => /מרכז ביצועים|Performance center/.test(b.textContent))?.click()`); await wait(1500);
  await js(`[...document.querySelectorAll('button')].find((b) => /איך עושים|How to/.test(b.textContent))?.click()`); await wait(600);
  console.log('guide dialog:', await js(`document.querySelector('.modal h2, .modal .modal-title, .modal b')?.textContent || 'none'`));
  console.log('dialog a11y:', JSON.stringify(await js(`({ role: document.querySelector('.modal')?.getAttribute('role'), labelled: !!document.getElementById(document.querySelector('.modal')?.getAttribute('aria-labelledby') || 'x'), focusInside: !!document.querySelector('.modal')?.contains(document.activeElement) })`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(400);
  console.log('Escape closes it:', !(await js(`!!document.querySelector('.modal')`)));
  await js(`[...document.querySelectorAll('.nav-item')].find((b) => /Startup apps|הפעלה עם Windows/.test(b.textContent))?.click()`); await wait(1200);
  console.log('switches:', await js(`[...document.querySelectorAll('.toggle')].length + ' toggles, ' + [...document.querySelectorAll('[role=switch][aria-checked]')].length + ' with role=switch'`));
  console.log('renderer errors:', errors.length ? errors.join(' | ') : 'none');
  app.exit(0);
});
